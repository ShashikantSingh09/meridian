From: Priya Nair <priya@acme.example>
Subject: Invitation: Quarterly planning @ Thu Nov 5, 2026 10am - 11am (EST)
Received: 2026-10-20T14:00:00Z
--- text
You have been invited to Quarterly planning.
--- calendar
BEGIN:VCALENDAR
PRODID:-//Example//Calendar//EN
VERSION:2.0
METHOD:REQUEST
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:STANDARD
DTSTART:19701101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261105T100000
DTEND;TZID=America/New_York:20261105T110000
UID:planning-q4@acme.example
SEQUENCE:0
SUMMARY:Quarterly plan
 ning\, Q4
LOCATION:Room 4\, Floor 2
ORGANIZER;CN="Priya Nair":mailto:priya@acme.example
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
STATUS:CONFIRMED
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Reminder
SUMMARY:Alarm text
TRIGGER:-PT10M
END:VALARM
END:VEVENT
END:VCALENDAR
