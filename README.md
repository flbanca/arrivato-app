# arrivaTO – sito

Sito statico di [arrivaTO](https://flbanca.github.io/arrivato-app/), app non ufficiale per gli arrivi di bus e tram a Torino (iOS sull’App Store; Android in test su Google Play).

- `index.html` – presentazione
- `android.html` – come entrare nel test su Google Play (niente APK da scaricare)
- `supporto.html` – assistenza e FAQ
- `accessibilita.html` – accessibilità
- `privacy.html` – informativa privacy
- `viaggio.html` – pagina del link «Avvisa chi ti aspetta», messaggio di partenza (dati solo nel frammento dopo «#»)
- `arrivo.html` – pagina del link del messaggio di arrivo (nessun dato)
- `avvisa.css`, `og-viaggio.jpg`, `og-arrivo.jpg` – stile e anteprime in chat delle due pagine
- `sitemap.xml` – mappa delle pagine pubbliche, da inviare a Search Console
- `llms.txt` – riassunto in testo semplice per gli assistenti AI

Ricerca e AI: `index.html` e `supporto.html` hanno dati strutturati (JSON-LD) in `<head>`. Le domande frequenti lì dentro sono una copia del testo della pagina: quando cambi una domanda o una funzione, aggiorna anche il JSON-LD e `llms.txt`. `viaggio.html` e `arrivo.html` hanno `noindex`.

Pubblicato con GitHub Pages dal branch `main`.
