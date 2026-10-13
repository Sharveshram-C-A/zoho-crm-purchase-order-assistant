# Setup guide

This guide walks through installing the Purchase Order PDF Assistant in your Zoho CRM org. Menu names in Zoho change from time to time, so if something is not where this guide says, search the Setup page for the item name.

## Prerequisites

- A Zoho CRM org with the **Purchase Orders** module, and admin access to create connections, functions, widgets and buttons
- A Groq account and an API key (console.groq.com/keys)
- Vendors and Products already created in CRM (the widget matches them by exact name)
- A browser with access to `cdnjs.cloudflare.com` (the widget loads PDF.js from there)

## 1. Create a Groq API key

1. Sign in at console.groq.com and create an API key.
2. Copy it once and store it somewhere safe. It starts with `gsk_`.
3. Check which models your key can use in the Playground model list. The default in this project is `qwen/qwen3.8-27b`. If it is not listed for you, choose another model from that list and use its exact ID in step 3.

Never commit the key to this repository or paste it into the widget code.

## 2. Create the Zoho connection

The connection keeps your API key out of the code.

1. Go to **Setup > Developer Hub > Connections** and create a new connection.
2. Choose **Custom Service** with **API Key** authentication.
3. Set the key parameter as follows:
   - Parameter type: **Header**
   - Parameter name: `Authorization`
   - Value: `Bearer gsk_your_key_here` (the word `Bearer`, one space, then the key, with no quotes)
4. Set the connection link name to `groq_connection` and save.

If you later see `Invalid API Key`, the usual cause is a missing `Bearer ` prefix, a missing space or a stray space or quote around the key.

## 3. Add the Deluge function

1. Go to **Setup > Developer Hub > Functions** and create a new standalone function.
2. Set the API name to `purchase_order_automation`. The name is case-sensitive and must match `DELUGE_FUNCTION_NAME` in `widget/app.js`.
3. Give it one argument, `msgs` of type Map, and a string return type.
4. Paste in the code from `deluge/purchase_order_automation.dg`:

```deluge
string standalone.purchase_order_automation(Map msgs)
{
    requestBody = Map();
    requestBody.put("model", "qwen/qwen3.8-27b");
    requestBody.put("max_tokens", 4000);

    messages = List();
    for each msg in msgs.get("data")
    {
        messages.add(msg);
    }
    requestBody.put("messages", messages);

    response = invokeurl
    [
        url : "https://api.groq.com/openai/v1/chat/completions"
        type : POST
        body : requestBody.toString()
        headers : {"Content-Type":"application/json"}
        connection : "groq_connection"
    ];

    return response;
}
```

`max_tokens` is set to 4000 because the default model reasons before answering and a purchase order with several line items needs room. If you get truncated or empty replies, raise it.

## 4. Upload the widget

1. Prepare the widget files: `widget.html` and `app.js`. Your `widget.html` must:
   - load the Zoho embedded app SDK (use the script URL given in Zoho's widget documentation)
   - load PDF.js before `app.js`:
     ```html
     <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
     ```
   - contain these element IDs: `pdfInput`, `inputField`, `submitBtn`, `responseBlock`, `proceedBtn` (give `proceedBtn` the `hidden` class so it stays out of sight until extraction finishes)
2. Zip the widget files.
3. Go to **Setup > Developer Hub > Widgets** and create a new widget:
   - Hosting: **Zoho**, uploading the zip
   - Index page: the path to `widget.html` inside the zip
   - Type: **Button**
4. Note the widget's **API name**. You choose it when attaching the widget to a button.

## 5. Add a button that opens the widget

1. Go to **Setup > Customization > Modules and Fields > Purchase Orders > Buttons** and create a new button.
2. For placement, choose **List View page** if you want a "Create from PDF" button on the Purchase Orders list. This fits best, because the widget creates a new record. A button on a record's detail page also works, but it does not use the open record.
3. For the action, choose **Open a widget** and select your widget.
4. Assign the button to the profiles that should see it.

## 6. Check permissions

The user who runs the widget needs:

- permission to **create** Purchase Orders
- permission to **view** Vendors, Products and Contacts (the widget searches them by name)
- access to run the Deluge function

## 7. Try it with the sample PDF

1. Open the Purchase Orders list and click your new button.
2. Choose `samples/sample_purchase_order.pdf` and click the extract button.
3. You should see a form filled with the values in `samples/expected_output.json`.
4. Before you click **Proceed**, make sure your CRM has a vendor named `Orion Industrial Supplies Pvt Ltd` and products named `Stainless Steel Sheet 304 (2mm)`, `Hex Bolt M10 x 50mm (Box of 100)` and `Industrial Lubricant Oil 20L`. Otherwise the widget will report the missing records, or you can rename them in the form to match records you already have.
5. Click **Proceed**. A success message shows the new record ID.

Use a sandbox or test org first. This creates real records.

## Customizing

| Change | Edit |
|---|---|
| Different Groq model | The `model` line in the Deluge function |
| Rename or add extracted fields | `HEADER_FIELDS` and `LINE_ITEM_FIELDS` in `app.js` |
| Send fields Zoho normally calculates | Remove names from `CALCULATED_HEADER` / `CALCULATED_ITEM` |
| Read more pages | `MAX_PAGES` (larger values mean more tokens and bigger requests) |
| Different line-item payload | `buildLineItemPayload` and `API_LINE_ITEMS_KEY` |

## Troubleshooting

Open the browser developer console while you test. The widget logs the payload size, the Deluge response, the Groq error (if any) and the exact record it sends to Zoho.

| Message | Likely cause and fix |
|---|---|
| `invalid_api_key` / `Invalid API Key` | The connection's key is wrong or malformed. Re-check the `Bearer gsk_...` value in step 2. |
| `model_not_found` | The model ID is not available to your account. Pick one from your Groq Playground list and update the Deluge function. |
| `invalid data` while extracting (before any Groq error) | The request to the Deluge function was rejected, usually because it was too large. Lower `MAX_PAGES`, `MAX_DIMENSION` or `JPEG_QUALITY`, or use a text-based PDF. |
| `Model did not return a JSON object` | The reply was empty or truncated. Raise `max_tokens` in the Deluge function. |
| `Vendor "..." was not found in Zoho CRM` | The vendor name does not match a CRM vendor exactly. Fix the name in the form or create the vendor. |
| `Product(s) not found in Zoho CRM` | Same, for products. |
| `MANDATORY_NOT_FOUND` with `Product_Details` | The record was sent with the old line-item key. Use `Product_Details` (see `API_LINE_ITEMS_KEY`). |
| `INVALID_DATA` naming a field | Often a picklist value that is not one of your options (Status, Carrier, State or Country). Fix it in the form. |
| Button does nothing | Check the widget's API name, that the button is assigned to your profile, and the console for script errors. |

If a field's error text is `undefined`, make sure you are using the latest `app.js`, which surfaces Zoho's real error message.