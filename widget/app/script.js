let purchaseOrderData = null;

// ---------- Deluge function that calls Groq (case-sensitive API name) ----------
const DELUGE_FUNCTION_NAME = "purchase_order_automation";

// ---------- PDF.js ----------
pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const MAX_PAGES = 4;
const MAX_DIMENSION = 1200;   // image fallback only
const JPEG_QUALITY = 0.6;     // image fallback only
const MIN_TEXT_CHARS = 100;   // below this, treat the PDF as scanned

// ---------- Zoho CRM Purchase_Orders field API names ----------
// Key used in the extracted JSON / form (the subform's name in Setup)
const LINE_ITEMS_KEY = "Purchase_Items";
// Key the CRM API expects when creating the record
const API_LINE_ITEMS_KEY = "Product_Details";

const HEADER_FIELDS = {
    Subject: "string - title/name of the purchase order",
    PO_Number: "string - purchase order number printed on the document",
    Vendor_Name: "string - vendor/supplier name exactly as printed (plain text, NOT an ID)",
    Requisition_No: "string - requisition number",
    Tracking_Number: "string - tracking number",
    Contact_Name: "string - contact person name (plain text, NOT an ID)",
    Carrier: "string - shipping carrier",
    PO_Date: "string - purchase order date, format yyyy-MM-dd",
    Due_Date: "string - due/delivery date, format yyyy-MM-dd",
    Status: "string - purchase order status, only if printed on the document",
    Excise_Duty: "number",
    Sales_Commission: "number",
    Terms_and_Conditions: "string",
    Description: "string - notes/remarks",
    Billing_Street: "string",
    Billing_City: "string",
    Billing_State: "string",
    Billing_Code: "string - postal/ZIP code",
    Billing_Country: "string",
    Shipping_Street: "string",
    Shipping_City: "string",
    Shipping_State: "string",
    Shipping_Code: "string - postal/ZIP code",
    Shipping_Country: "string",
    Sub_Total: "number - total before discount, tax and adjustment",
    Discount: "number - overall discount amount",
    Tax: "number - total tax amount",
    Adjustment: "number",
    Grand_Total: "number - final total"
};

const LINE_ITEM_FIELDS = {
    Product_Name: "string - product/item name as printed (plain text, NOT an ID)",
    Product_Description: "string",
    Quantity: "number",
    List_Price: "number - price per unit",
    Total: "number - Quantity x List_Price",
    Discount: "number - discount amount for this line",
    Total_After_Discount: "number - Total minus Discount",
    Tax: "number - tax amount for this line",
    Net_Total: "number - Total_After_Discount plus Tax"
};

// Zoho calculates these from the line items: shown read-only, never sent.
const CALCULATED_HEADER = ["Sub_Total", "Discount", "Tax", "Grand_Total"];
const CALCULATED_ITEM = ["Total", "Total_After_Discount", "Tax", "Net_Total"];
const DEFAULT_ITEM_COLUMNS = ["Product_Name", "Quantity", "List_Price"];

// One line item in the insert payload (API v8 "Product_Details" shape)
function buildLineItemPayload(item, productId) {
    const out = { product: { id: productId } };
    if (item.Quantity !== undefined) out.quantity = item.Quantity;
    if (item.List_Price !== undefined) out.list_price = item.List_Price;
    if (item.Discount !== undefined) out.Discount = item.Discount;
    if (item.Product_Description) out.product_description = item.Product_Description;
    return out;
}

// ---------- Prompt ----------
function describeFields(fields) {
    return Object.entries(fields)
        .map(([name, desc]) => `  - ${name}: ${desc}`)
        .join("\n");
}

function buildPrompt(extraInstructions, source) {
    const what =
        source === "text"
            ? "the following text extracted from a PDF"
            : "these PDF page images";

    return `Extract purchase order details from ${what}.

Return ONLY a valid JSON object. Use ONLY the following Zoho CRM
Purchase_Orders field API names as keys (exact spelling and casing).

HEADER FIELDS:
${describeFields(HEADER_FIELDS)}

LINE ITEMS: put every line item in an array under the key "${LINE_ITEMS_KEY}".
Each element may use ONLY these keys:
${describeFields(LINE_ITEM_FIELDS)}

RULES:
- Include a key only if its value is clearly visible in the document.
- Do not invent or guess missing values. Omit the key instead.
- Copy names and addresses exactly as written, with the same spelling.
- Do not return Zoho record IDs. Vendor_Name, Contact_Name and Product_Name are plain text.
- Numbers must be plain numbers (no currency symbols, no thousands separators).
- Dates must be formatted yyyy-MM-dd.
- Do not create any CRM records.
- Return JSON only, with no Markdown and no explanations.` +
        (extraInstructions
            ? `\n\nAdditional instructions: ${extraInstructions}`
            : "");
}

// Keep only known field names
function sanitize(po) {
    const clean = {};

    for (const key of Object.keys(HEADER_FIELDS)) {
        if (po[key] !== undefined && po[key] !== null && po[key] !== "") {
            clean[key] = po[key];
        }
    }

    const rawItems = po[LINE_ITEMS_KEY];
    if (Array.isArray(rawItems)) {
        clean[LINE_ITEMS_KEY] = rawItems.map(item => {
            const out = {};
            for (const key of Object.keys(LINE_ITEM_FIELDS)) {
                if (
                    item &&
                    item[key] !== undefined &&
                    item[key] !== null &&
                    item[key] !== ""
                ) {
                    out[key] = item[key];
                }
            }
            return out;
        });
    }

    return clean;
}

// Turn any thrown value (Error, Zoho SDK rejection object, string) into readable text
function describeError(e) {
    if (!e) return "Unknown error";
    if (typeof e === "string") return e;
    if (typeof e.message === "string" && e.message) return e.message;
    const row = e.data && e.data[0];
    if (row) {
        return `${row.code || ""}: ${row.message || ""}\n${JSON.stringify(row.details || {})}`;
    }
    try {
        return JSON.stringify(e);
    } catch (_) {
        return String(e);
    }
}

// ---------- Zoho widget ----------
ZOHO.embeddedApp.on("PageLoad", function () {
    const submit = document.getElementById("submitBtn");
    const pdfInput = document.getElementById("pdfInput");
    const inputField = document.getElementById("inputField");
    const responseBlock = document.getElementById("responseBlock");
    const proceedBtn = document.getElementById("proceedBtn");

    // ===== PDF reading =====
    async function extractPdfText(file) {
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        const pages = [];

        for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();

            const rows = new Map();
            content.items.forEach(it => {
                const y = Math.round(it.transform[5] / 3);
                if (!rows.has(y)) rows.set(y, []);
                rows.get(y).push({ x: it.transform[4], s: it.str });
            });

            const lines = [...rows.entries()]
                .sort((a, b) => b[0] - a[0])
                .map(([, cells]) =>
                    cells.sort((a, b) => a.x - b.x).map(c => c.s).join("  ").trim())
                .filter(Boolean);

            pages.push(`--- Page ${i} ---\n` + lines.join("\n"));
        }

        return pages.join("\n\n");
    }

    async function pdfToImages(file) {
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        const pageCount = Math.min(pdf.numPages, MAX_PAGES);
        const images = [];

        for (let i = 1; i <= pageCount; i++) {
            const page = await pdf.getPage(i);
            const base = page.getViewport({ scale: 1 });
            const scale = MAX_DIMENSION / Math.max(base.width, base.height);
            const viewport = page.getViewport({ scale });

            const canvas = document.createElement("canvas");
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            const ctx = canvas.getContext("2d");

            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            await page.render({ canvasContext: ctx, viewport }).promise;
            images.push(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
        }

        return images;
    }

    // ===== Dynamic form =====
    const INPUT_STYLE =
        "width:100%;box-sizing:border-box;padding:4px 6px;font:inherit;";

    function makeInput({ key, value, desc, readOnly, group }) {
        const isNumber =
            typeof value === "number" || (desc || "").startsWith("number");
        const isDate =
            (desc || "").includes("yyyy-MM-dd") ||
            (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
        const isLong =
            typeof value === "string" &&
            (value.length > 60 || value.includes("\n"));

        let input;
        if (isLong) {
            input = document.createElement("textarea");
            input.rows = 4;
        } else {
            input = document.createElement("input");
            input.type = isNumber ? "number" : isDate ? "date" : "text";
            if (isNumber) input.step = "any";
        }

        input.value = value === undefined || value === null ? "" : value;
        input.style.cssText = INPUT_STYLE;
        input.dataset.type = isNumber ? "number" : "text";

        if (group === "po") input.dataset.poKey = key;
        else input.dataset.itemKey = key;

        if (readOnly) {
            input.readOnly = true;
            input.dataset.readonly = "1";
            input.style.opacity = "0.6";
            input.title = "Calculated by Zoho from the line items";
        }
        return input;
    }

    function addItemRow(tbody, columns, item) {
        const tr = document.createElement("tr");
        tr.dataset.itemRow = "1";

        columns.forEach(col => {
            const td = document.createElement("td");
            td.style.cssText = "border:1px solid #ccc;padding:2px;min-width:90px";
            td.appendChild(
                makeInput({
                    key: col,
                    value: item[col],
                    desc: LINE_ITEM_FIELDS[col],
                    readOnly: CALCULATED_ITEM.includes(col),
                    group: "item"
                })
            );
            tr.appendChild(td);
        });

        const delTd = document.createElement("td");
        delTd.style.cssText = "border:1px solid #ccc;padding:2px;text-align:center";
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "✕";
        del.title = "Remove this line item";
        del.addEventListener("click", () => tr.remove());
        delTd.appendChild(del);
        tr.appendChild(delTd);

        tbody.appendChild(tr);
    }

    function renderForm(po) {
        responseBlock.innerHTML = "";

        const form = document.createElement("div");
        form.id = "poForm";

        // Header fields: one input per key in the JSON
        const grid = document.createElement("div");
        grid.style.cssText =
            "display:grid;grid-template-columns:150px 1fr;gap:6px 10px;align-items:start;font-size:13px";

        Object.keys(po)
            .filter(k => k !== LINE_ITEMS_KEY && typeof po[k] !== "object")
            .forEach(k => {
                const readOnly = CALCULATED_HEADER.includes(k);

                const label = document.createElement("div");
                const name = document.createElement("strong");
                name.textContent = k.replace(/_/g, " ");
                const api = document.createElement("small");
                api.style.cssText = "display:block;opacity:.6";
                api.textContent = k + (readOnly ? " (calculated)" : "");
                label.append(name, api);

                grid.append(
                    label,
                    makeInput({
                        key: k,
                        value: po[k],
                        desc: HEADER_FIELDS[k],
                        readOnly,
                        group: "po"
                    })
                );
            });
        form.appendChild(grid);

        // Line items table: columns come from the keys in the data
        const items = Array.isArray(po[LINE_ITEMS_KEY]) ? po[LINE_ITEMS_KEY] : [];
        const columns = Object.keys(LINE_ITEM_FIELDS).filter(
            c => DEFAULT_ITEM_COLUMNS.includes(c) || items.some(it => it[c] !== undefined)
        );

        const heading = document.createElement("h4");
        heading.style.margin = "14px 0 4px";
        heading.textContent = "Line items";
        form.appendChild(heading);

        const wrap = document.createElement("div");
        wrap.style.overflowX = "auto";

        const table = document.createElement("table");
        table.style.cssText = "border-collapse:collapse;font-size:12px";

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        columns.concat([""]).forEach(c => {
            const th = document.createElement("th");
            th.style.cssText = "border:1px solid #ccc;padding:3px 6px;text-align:left";
            th.textContent = c.replace(/_/g, " ");
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);

        const tbody = document.createElement("tbody");
        items.forEach(it => addItemRow(tbody, columns, it));

        table.append(thead, tbody);
        wrap.appendChild(table);
        form.appendChild(wrap);

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.textContent = "+ Add line item";
        addBtn.style.marginTop = "6px";
        addBtn.addEventListener("click", () => addItemRow(tbody, columns, {}));
        form.appendChild(addBtn);

        const status = document.createElement("div");
        status.id = "poStatus";
        status.style.cssText = "margin-top:10px;font-size:13px;white-space:pre-wrap";

        responseBlock.append(form, status);
    }

    function setStatus(message, kind) {
        const el = document.getElementById("poStatus");
        if (!el) return;
        el.textContent = message;
        el.style.color =
            kind === "error" ? "#b00020" : kind === "ok" ? "#1b7f3b" : "inherit";
    }

    function readValue(input) {
        if (input.dataset.type === "number") {
            return input.value === "" ? "" : Number(input.value);
        }
        return input.value.trim();
    }

    // Read the (possibly edited) form back into an object
    function collectForm() {
        const po = {};
        responseBlock.querySelectorAll("[data-po-key]").forEach(input => {
            if (input.dataset.readonly) return;
            const v = readValue(input);
            if (v !== "") po[input.dataset.poKey] = v;
        });

        const items = [];
        responseBlock.querySelectorAll("tr[data-item-row]").forEach(tr => {
            const item = {};
            tr.querySelectorAll("[data-item-key]").forEach(input => {
                if (input.dataset.readonly) return;
                const v = readValue(input);
                if (v !== "") item[input.dataset.itemKey] = v;
            });
            if (Object.keys(item).length) items.push(item);
        });

        return { po, items };
    }

    // ===== Zoho CRM SDK: lookups and record creation =====
    const escapeCriteria = s => String(s).replace(/([\\(),:])/g, "\\$1");

    async function findRecordId(entity, field, value) {
        try {
            const resp = await ZOHO.CRM.API.searchRecord({
                Entity: entity,
                Type: "criteria",
                Query: `(${field}:equals:${escapeCriteria(value)})`
            });
            return resp && Array.isArray(resp.data) && resp.data.length
                ? resp.data[0].id
                : null;
        } catch (e) {
            console.warn(`Search failed in ${entity}:`, describeError(e));
            return null;
        }
    }

    async function createPurchaseOrder() {
        const { po, items } = collectForm();

        if (!po.Subject) throw new Error("Subject is required.");
        if (!po.Vendor_Name) throw new Error("Vendor Name is required.");
        if (!items.length) throw new Error("Add at least one line item.");

        items.forEach((it, i) => {
            const n = i + 1;
            if (!it.Product_Name) throw new Error(`Line ${n}: Product Name is required.`);
            if (!(it.Quantity > 0)) throw new Error(`Line ${n}: Quantity must be greater than 0.`);
            if (typeof it.List_Price !== "number") throw new Error(`Line ${n}: List Price is required.`);
        });

        setStatus("Looking up vendor...");
        const vendorId = await findRecordId("Vendors", "Vendor_Name", po.Vendor_Name);
        if (!vendorId) {
            throw new Error(
                `Vendor "${po.Vendor_Name}" was not found in Zoho CRM.\n` +
                `Correct the name in the form or create the vendor first.`
            );
        }

        let contactId = null;
        if (po.Contact_Name) {
            setStatus("Looking up contact...");
            contactId = await findRecordId("Contacts", "Full_Name", po.Contact_Name);
        }

        setStatus("Looking up products...");
        const productIds = {};
        const missing = [];
        for (const it of items) {
            const name = it.Product_Name;
            if (!(name in productIds)) {
                productIds[name] = await findRecordId("Products", "Product_Name", name);
            }
            if (!productIds[name]) missing.push(name);
        }
        if (missing.length) {
            throw new Error(
                `Product(s) not found in Zoho CRM: ${[...new Set(missing)].join(", ")}\n` +
                `Correct the names in the form or create the products first.`
            );
        }

        // Build the record: skip lookups (resolved to IDs) and calculated fields
        const record = {};
        Object.keys(po).forEach(k => {
            if (k === "Vendor_Name" || k === "Contact_Name") return;
            if (CALCULATED_HEADER.includes(k)) return;
            record[k] = po[k];
        });
        record.Vendor_Name = { id: vendorId };
        if (contactId) record.Contact_Name = { id: contactId };
        record[API_LINE_ITEMS_KEY] = items.map(it =>
            buildLineItemPayload(it, productIds[it.Product_Name])
        );

        console.log("Creating Purchase Order:", record);
        setStatus("Creating purchase order...");

        let resp;
        try {
            resp = await ZOHO.CRM.API.insertRecord({
                Entity: "Purchase_Orders",
                APIData: record
            });
        } catch (e) {
            console.error("insertRecord rejected:", e);
            throw new Error(describeError(e));
        }
        console.log("insertRecord response:", resp);

        const row = resp && resp.data && resp.data[0];
        if (!row || row.code !== "SUCCESS") {
            throw new Error(
                row
                    ? `${row.code}: ${row.message}\n${JSON.stringify(row.details || {})}`
                    : "Unexpected response: " + JSON.stringify(resp)
            );
        }

        return {
            id: row.details.id,
            contactSkipped: Boolean(po.Contact_Name && !contactId)
        };
    }

    // ===== Extraction =====
    submit.addEventListener("click", async function () {
        try {
            const file = pdfInput.files[0];

            if (!file) {
                throw new Error("Please choose a purchase order PDF.");
            }

            if (
                file.type !== "application/pdf" &&
                !file.name.toLowerCase().endsWith(".pdf")
            ) {
                throw new Error("Please upload a PDF file.");
            }

            submit.disabled = true;
            proceedBtn.classList.add("hidden");
            proceedBtn.disabled = false;
            purchaseOrderData = null;

            responseBlock.textContent = "Reading PDF...";
            const extra = inputField.value.trim();
            const text = await extractPdfText(file);

            let userContent;
            if (text.replace(/\s/g, "").length > MIN_TEXT_CHARS) {
                userContent = [
                    {
                        type: "text",
                        text:
                            buildPrompt(extra, "text") +
                            "\n\nDOCUMENT TEXT:\n" +
                            text
                    }
                ];
            } else {
                responseBlock.textContent = "No text found, using page images...";
                const images = await pdfToImages(file);
                userContent = [
                    { type: "text", text: buildPrompt(extra, "images") },
                    ...images.map(url => ({
                        type: "image_url",
                        image_url: { url }
                    }))
                ];
            }

            const reqData = {
                arguments: JSON.stringify({
                    msgs: {
                        data: [{ role: "user", content: userContent }]
                    }
                })
            };

            console.log(
                "payload KB:",
                Math.round(JSON.stringify(reqData).length / 1024)
            );

            responseBlock.textContent = "Extracting purchase order details...";

            let result;
            try {
                result = await ZOHO.CRM.FUNCTIONS.execute(
                    "purchase_order_automation",
                    reqData
                );
            } catch (e) {
                console.error("execute rejected:", JSON.stringify(e));
                throw new Error(describeError(e));
            }

            console.log("Deluge response:", result);

            if (!result || result.code !== "success") {
                throw new Error(
                    result?.message || "The Deluge function failed."
                );
            }

            const rawOutput = result.details.output;
            const groqResponse =
                typeof rawOutput === "string"
                    ? JSON.parse(rawOutput)
                    : rawOutput;

            if (groqResponse.error) {
                console.error("Groq error:", groqResponse.error);
                throw new Error(
                    [
                        groqResponse.error.type,
                        groqResponse.error.code,
                        groqResponse.error.message
                    ]
                        .filter(Boolean)
                        .join(" | ")
                );
            }

            const messageText = groqResponse?.choices?.[0]?.message?.content;
            if (!messageText) {
                throw new Error("Groq returned no message content.");
            }

            const start = messageText.indexOf("{");
            const end = messageText.lastIndexOf("}");
            if (start === -1 || end === -1) {
                throw new Error("Model did not return a JSON object.");
            }

            const parsed = JSON.parse(messageText.slice(start, end + 1));

            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("Model did not return a JSON object.");
            }

            purchaseOrderData = sanitize(parsed);

            renderForm(purchaseOrderData);
            proceedBtn.classList.remove("hidden");

        } catch (error) {
            console.error("Extraction error:", error);
            responseBlock.textContent =
                "Error extracting purchase order: " + describeError(error);
        } finally {
            submit.disabled = false;
        }
    });

    // ===== Proceed: create the purchase order =====
    proceedBtn.addEventListener("click", async function () {
        proceedBtn.disabled = true;
        try {
            const created = await createPurchaseOrder();
            setStatus(
                `Purchase order created. Record ID: ${created.id}` +
                    (created.contactSkipped
                        ? "\nNote: the contact was not found in CRM, so it was left blank."
                        : ""),
                "ok"
            );
            proceedBtn.classList.add("hidden");
        } catch (error) {
            console.error("Create error:", error);
            setStatus(
                "Could not create the purchase order:\n" + describeError(error),
                "error"
            );
            proceedBtn.disabled = false;
        }
    });
});

ZOHO.embeddedApp.init();