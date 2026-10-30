From: Alder & Pine <orders@alderandpine.example>
Subject: Order received
Received: 2026-10-18T16:45:00Z
--- html
<html><body>
<script type="application/ld+json">
{
  "@context": "http://schema.org",
  "@graph": [
    {"@type": "WebSite", "name": "Alder & Pine", "url": "https://alderandpine.example"},
    {
      "@type": "http://schema.org/Order",
      "merchant": {"@type": "Organization", "name": "Alder & Pine"},
      "orderNumber": "AP-204417",
      "price": "84.50",
      "priceCurrency": "USD",
      "orderStatus": "http://schema.org/OrderProcessing",
      "url": "https://alderandpine.example/orders/AP-204417"
    }
  ]
}
</script>
</body></html>
