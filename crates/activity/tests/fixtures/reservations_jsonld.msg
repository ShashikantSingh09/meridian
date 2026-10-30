From: Citypass <tickets@citypass.example>
Subject: Your weekend bookings
Received: 2026-10-05T18:00:00Z
--- html
<html><body>
<script type="application/ld+json">
[
  {
    "@context": "http://schema.org",
    "@type": "EventReservation",
    "reservationNumber": "EV7741",
    "reservationFor": {
      "@type": "Event",
      "name": "Northern Lights Concert",
      "startDate": "2026-12-11T19:30:00+00:00",
      "endDate": "2026-12-11T22:00:00+00:00",
      "location": {"@type": "Place", "name": "Harpa Hall", "address": {"streetAddress": "Austurbakki 2", "addressLocality": "Reykjavik"}}
    }
  },
  {
    "@context": "http://schema.org",
    "@type": "FoodEstablishmentReservation",
    "reservationNumber": "T-5521",
    "partySize": 4,
    "startTime": "2026-12-12T20:00:00",
    "reservationFor": {"@type": "FoodEstablishment", "name": "The Fishmonger", "address": "12 Harbour Street"}
  },
  {
    "@context": "http://schema.org",
    "@type": "RentalCarReservation",
    "reservationNumber": "CAR-8810",
    "provider": {"@type": "Organization", "name": "Glacier Rentals"},
    "reservationFor": {"@type": "Car", "name": "Compact SUV"},
    "pickupLocation": {"@type": "Place", "name": "Keflavik Airport"},
    "pickupTime": "2026-12-13T09:00:00+00:00",
    "dropoffLocation": {"@type": "Place", "name": "Keflavik Airport"},
    "dropoffTime": "2026-12-15T09:00:00+00:00"
  }
]
</script>
</body></html>
