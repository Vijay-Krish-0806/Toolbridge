# Refund policy

Demo content for the ToolBridge host store. The rules marked "(enforced by the API)" match what the store API checks; the others are store policy that staff and the agent must follow.

## Who can refund

Support staff and the owner can request a refund. Only the owner can approve or reject a refund (enforced by the API). A request starts as pending, and no money moves until the owner approves it. Warehouse staff cannot request refunds.

## When an order can be refunded

A refund can only be requested for an order that has shipped or been delivered (enforced by the API). An order that is still pending or paid has not left the warehouse: cancel it instead of refunding it.

Refunds must be requested within 30 days of delivery. Gold tier customers get 45 days. After the window, a refund needs the owner's approval as an exception, and the request must say why.

## How much can be refunded

An order can have several partial refunds, but together they can never exceed the order total (enforced by the API). Every pending request already counts against the order, so two staff members cannot refund the same money twice.

Shipping costs are refunded only for damaged items, items not as described, and late deliveries.

## Damaged items

Ask the customer for a photo of the damage within 7 days of delivery. Use the reason `damaged`. For items under $25, the customer does not need to send the item back. For items of $25 or more, the customer returns the item, and the store pays the return shipping.

## Not as described

Use the reason `not_as_described` when the customer received the wrong item, size or colour, or the item does not match its product page. The store pays the return shipping, and the full amount including shipping is refunded.

## Late deliveries

When a shipment arrives more than 3 days after its estimated delivery date, offer to refund the shipping cost with the reason `late_delivery`. The customer keeps the item. If the parcel is lost, follow the lost parcel rules in the shipping rules.

## Changed their mind

Use the reason `changed_mind`. The item must be unused and in its original packaging, and the customer pays the return shipping. Shipping costs are not refunded. Personalised items and opened food items cannot be refunded for a change of mind.

## Rejecting a refund

The owner may reject a refund when the item was clearly used, the request is outside the window without a good reason, or the photo does not show the claimed damage. A rejection must include a reason that can be shared with the customer.
