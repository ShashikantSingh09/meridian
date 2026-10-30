From: Alder & Pine <shipping@alderandpine.example>
Subject: Your parcel is on its way
Received: 2026-10-20T10:00:00Z
--- html
<html><body>
<script type="application/ld+json">
{
  "@context": "http://schema.org",
  "@type": "ParcelDelivery",
  "carrier": {"@type": "Organization", "name": "Royal Mail"},
  "trackingNumber": "RM123456789GB",
  "trackingUrl": "https://track.alderandpine.example/RM123456789GB",
  "expectedArrivalFrom": "2026-10-22",
  "expectedArrivalUntil": "2026-10-23",
  "deliveryStatus": "http://schema.org/OrderInTransit",
  "partOfOrder": {"@type": "Order", "orderNumber": "AP-204417", "merchant": {"name": "Alder & Pine"}}
}
</script>
</body></html>
