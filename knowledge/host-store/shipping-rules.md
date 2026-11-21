# Shipping rules

Demo content for the ToolBridge host store. The rules marked "(enforced by the API)" match what the store API checks; the others are store policy that staff and the agent must follow.

## Who ships orders

Warehouse staff and the owner create shipments and mark them delivered (enforced by the API). Support staff cannot ship orders; they ask the warehouse instead.

## Warehouses and carriers

The store ships from two warehouses, east and west. Each order ships from the warehouse recorded on it. The carriers are UPS, FedEx, DHL and USPS (enforced by the API). Use USPS for domestic parcels under 2 kg, UPS or FedEx for heavier domestic parcels, and DHL for international orders.

## Processing time

Paid orders ship within 2 business days. Orders paid after 2 pm ship from the next business day. Pending orders, which are not paid yet, are never shipped.

## Delivery times

Standard domestic delivery takes 3 to 7 business days after shipping. International delivery with DHL takes 7 to 14 business days. Every shipment gets an estimated delivery date from the carrier when it is created, and that date is what customers are told.

## Delayed shipments

A shipment is delayed when it is still in transit after its estimated delivery date. The store does not store a "delayed" flag; staff find delays by comparing the estimated date with today. Contact the customer once a shipment is 2 days late, and offer a shipping refund once it is more than 3 days late (see the refund policy).

## Lost parcels

A parcel still in transit 10 days after its estimated delivery date is treated as lost. Open a claim with the carrier, then either send a replacement or refund the order in full, whichever the customer prefers. Lost parcels over $200 must be escalated to the owner.

## Changing the address

The delivery address can only change before the order ships. Update the customer's address and add an order note saying what changed. After shipping, the address cannot be changed; the customer must contact the carrier.

## Cancelling before shipping

An order can only be cancelled while it is pending or paid (enforced by the API). Once it has shipped, it cannot be cancelled; the customer can ask for a refund after delivery instead.
