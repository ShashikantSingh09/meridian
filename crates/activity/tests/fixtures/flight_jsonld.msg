From: Northwind Airways <bookings@northwind-air.example>
Subject: Your trip to Reykjavik - booking RXJ34P
Received: 2026-10-01T09:00:00Z
--- text
Your trip is booked. Booking reference: RXJ34P. Flight NW100 BOS to KEF.
--- html
<html><head>
<script type="application/ld+json">
{"@context":"http://schema.org","@type":"Organization","name":"Northwind Airways"}
</script>
<script type='application/ld+json'>
[
  {
    "@context": "http://schema.org",
    "@type": "FlightReservation",
    "reservationNumber": "RXJ34P",
    "reservationStatus": "http://schema.org/ReservationConfirmed",
    "underName": {"@type": "Person", "name": "Alex Morgan"},
    "reservationFor": {
      "@type": "Flight",
      "flightNumber": "100",
      "airline": {"@type": "Airline", "name": "Northwind Airways", "iataCode": "NW"},
      "departureAirport": {"@type": "Airport", "name": "Boston Logan", "iataCode": "BOS"},
      "departureTime": "2026-11-20T19:40:00-05:00",
      "arrivalAirport": {"@type": "Airport", "name": "Keflavik", "iataCode": "KEF"},
      "arrivalTime": "2026-11-21T05:05:00+00:00"
    }
  },
  {
    "@context": "http://schema.org",
    "@type": "FlightReservation",
    "reservationNumber": "RXJ34P",
    "reservationFor": {
      "@type": "Flight",
      "flightNumber": "NW101",
      "airline": {"@type": "Airline", "name": "Northwind Airways", "iataCode": "NW"},
      "departureAirport": {"@type": "Airport", "iataCode": "KEF"},
      "departureTime": "2026-11-27T17:00:00",
      "arrivalAirport": {"@type": "Airport", "iataCode": "BOS"}
    }
  }
]
</script>
</head><body><p>Your trip is booked.</p></body></html>
