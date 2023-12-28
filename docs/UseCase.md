## Messagestore

Un cittadino tramite portali dedicati possono leggere le notifiche salvate sul Message Store.

Nell'esempio seguente il cittadino ha il CF **PPPPLT80R10M082K**.

1. Il cittadino recupera i messaggi che gli sono stati iniviati:
	
	**GET /api/v1/users/PPPPLT80R10M082K/messages**

	Headers:
	```
	x-authentication: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1dWlkIjoiMzViMTYwNTAtY2MzMS00YTJlLTgxOTMtYWI1ZjM3MGQ2OTM1IiwicHJlZmVyZW5jZV9zZXJ2aWNlX25hbWUiOiJkZW1vX2ZlIiwiZXhwIjoyNTM0MDIyOTcxNDAsImlhdCI6MTYxNjQyNzc4MCwiYXBwbGljYXRpb25zIjp7InByZWZlcmVuY2VzIjpbInJlYWQiLCJ3cml0ZSJdLCJtZXgiOlsicmVhZCIsIndyaXRlIl0sImV2ZW50cyI6WyJyZWFkIl19LCJwcmVmZXJlbmNlcyI6e319.akQYdm0kPqqdtKUM1y2NSJxMMqCLYUsdS7Nh4xsqlTQ
	
	Shib-Iride-IdentitaDigitale: PPPPLT80R10M082K
	```

1. Il cittadino legge uno specifico messaggio:

    **GET /api/v1/users/PPPPLT80R10M082K/messages/3703a6cd-7c63-4739-876d-6335c1302d66**

	Headers:
	```
	x-authentication: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1dWlkIjoiMzViMTYwNTAtY2MzMS00YTJlLTgxOTMtYWI1ZjM3MGQ2OTM1IiwicHJlZmVyZW5jZV9zZXJ2aWNlX25hbWUiOiJkZW1vX2ZlIiwiZXhwIjoyNTM0MDIyOTcxNDAsImlhdCI6MTYxNjQyNzc4MCwiYXBwbGljYXRpb25zIjp7InByZWZlcmVuY2VzIjpbInJlYWQiLCJ3cml0ZSJdLCJtZXgiOlsicmVhZCIsIndyaXRlIl0sImV2ZW50cyI6WyJyZWFkIl19LCJwcmVmZXJlbmNlcyI6e319.akQYdm0kPqqdtKUM1y2NSJxMMqCLYUsdS7Nh4xsqlTQ
	
	Shib-Iride-IdentitaDigitale: PPPPLT80R10M082K
	```

1. Il cittadino imposta come letto un messaggio:
    
	**PUT /api/v1/users/PPPPLT80R10M082K/messages/status**

	Headers:
	```
	x-authentication: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1dWlkIjoiMzViMTYwNTAtY2MzMS00YTJlLTgxOTMtYWI1ZjM3MGQ2OTM1IiwicHJlZmVyZW5jZV9zZXJ2aWNlX25hbWUiOiJkZW1vX2ZlIiwiZXhwIjoyNTM0MDIyOTcxNDAsImlhdCI6MTYxNjQyNzc4MCwiYXBwbGljYXRpb25zIjp7InByZWZlcmVuY2VzIjpbInJlYWQiLCJ3cml0ZSJdLCJtZXgiOlsicmVhZCIsIndyaXRlIl0sImV2ZW50cyI6WyJyZWFkIl19LCJwcmVmZXJlbmNlcyI6e319.akQYdm0kPqqdtKUM1y2NSJxMMqCLYUsdS7Nh4xsqlTQ
	
	Shib-Iride-IdentitaDigitale: PPPPLT80R10M082K
	```

	Body:
	```  
	[
		{
			"id": "3703a6cd-7c63-4739-876d-6335c1302d66",
			"read_at": "read",
			"tag": "noticed"
		}
	]
	```  
