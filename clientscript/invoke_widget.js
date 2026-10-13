const WIDGET_API_NAME = "Purchase_Order_Automation";

ZDK.Client.createFlyout("purchaseOrderAssistant", {
    header: "AI Purchase Order Assistant",
    animation_type: 3,
    height: "600px",
    width: "550px",
    top: "center",
    right: "center"
});

ZDK.Client.getFlyout("purchaseOrderAssistant").open({
    api_name: WIDGET_API_NAME,
    type: "widget"
});

try {
    const response = await ZDK.Client
        .getFlyout("purchaseOrderAssistant")
        .notify(
            { data: { message: "Start purchase order extraction" } },
            { wait: true }
        );

    const purchaseOrderData =
        typeof response === "string" ? JSON.parse(response) : response;

    if (
        !purchaseOrderData ||
        typeof purchaseOrderData !== "object" ||
        Array.isArray(purchaseOrderData)
    ) {
        throw new Error("Invalid purchase order data received.");
    }

    ZDK.Client.getFlyout("purchaseOrderAssistant").close();

    ZDK.Client.navigateTo("record_create", {
        module: "Purchase_Orders",
        custom_data: { purchaseOrderData: purchaseOrderData }
    });

} catch (error) {
    console.error("Purchase Order navigation error:", error);
    ZDK.Client.showMessage(
        "Could not open the Purchase Order form: " + error.message,
        { type: "error" }
    );
    ZDK.Client.getFlyout("purchaseOrderAssistant").close();
    return false;
}