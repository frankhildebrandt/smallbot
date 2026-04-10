# Task

ich habe eine api die folgendes zurückgibt:

<APIDATA>
---
anfrage:
  - name: "test123"
    attribute:
    - foo
    - bar
  - name: "vhfdjkhjkl"
    attribute:
    - mee
    - moo
</APIDATA>

ich möchte einen webservice haben der wenn ich ihn abfrage das <APIDATA /> an nimmt und daraus ein:

<RESULT>
Hallo!

ich kenne test123 er kann kannst foo, bar,
und vhfdjkhjkl er kann mee, moo
</RESULT>

# Erwartetes ergebniss
- wenn der rest-service mit den <APIDATA /> aufgerufen wird, gibt er <RESULT /> zurück 
- der erzeugte programmcode nutzt keine materialisierten daten für <RESULT />
