# Pubblicare la Telegram Mini App

La Mini App di SinfonIA (`/app/tg`) si apre dentro Telegram solo da un indirizzo **https** pubblico. Questa guida porta lo staging del PC su Internet attraverso un tunnel, per provarla dal telefono.

Lo staging contiene solo dati di prova. Prima di usarla con dati reali di TerreFVG servono il server definitivo e le verifiche privacy già previste.

## 1. Avviare lo staging in modalità pubblica

In questa modalità lo staging accetta **solo** l'accesso dalla Mini App: dati firmati da Telegram, per account già collegati con `/accedi`. Restano spenti:

- il login con codice email (D11 ancora aperta);
- i codici mostrati a schermo;
- l'anteprima di prova;
- gli inviti;
- la console della piattaforma.

Il server risponde solo su `127.0.0.1`: il tunnel lo raggiunge da questo PC.

1. Ferma lo staging locale, se è avviato (Ctrl+C, oppure chiedi a Claude).
2. Avvia il tunnel (punto 2) e annota l'indirizzo `https://…` che ti dà.
3. Avvia lo staging con quell'indirizzo:

```bash
npm run staging:start -- --public --public-url=https://<indirizzo-del-tunnel>
```

L'indirizzo è accettato solo se è `https://`, senza percorso né parametri. `--public` e `--dashboard-login` non vanno insieme.

**Collegare nuovi account:** in modalità pubblica il login email è spento, quindi `/accedi` non è disponibile. Gli account da usare vanno collegati prima, con lo staging avviato in modalità `--dashboard-login`.

## 2. Il tunnel HTTPS

### Prova rapida, senza account

Cloudflare offre un tunnel temporaneo gratuito. L'indirizzo cambia a ogni avvio.

1. Installa `cloudflared` dal sito di Cloudflare. È un programma del PC, quindi lo installi tu.
2. In un terminale lancia:

```bash
cloudflared tunnel --url http://localhost:3110
```

3. Copia l'indirizzo `https://<nome>.trycloudflare.com` che compare.

Il tunnel resta attivo finché quel terminale è aperto e il PC è acceso.

### Indirizzo stabile (per far provare TerreFVG)

Servono un account Cloudflare gratuito e un dominio vostro (es. `app.sinfonia.it`). Si crea un tunnel con nome, legato a quel dominio. È una scelta da fare insieme: servizio esterno e dominio.

## 3. Il pulsante del bot

### Con BotFather

Lo imposti tu, dal tuo Telegram.

1. Scrivi a **@BotFather** e scegli `/mybots`, poi il bot di SinfonIA.
2. Vai su **Bot Settings → Menu Button**.
3. Inserisci l'indirizzo `https://<indirizzo-del-tunnel>/app/tg` e il titolo `SinfonIA`.

Accanto al campo di scrittura compare il pulsante che apre la Mini App.

### Nella chat

In modalità pubblica il bot offre l'app anche da solo:

- con il comando `/app` (oppure «app», «apri app»);
- subito dopo il saluto di `/start`, con il pulsante «📱 Apri SinfonIA».

## 4. Prova

1. Dal telefono, nella chat con il bot, scrivi `/app` oppure usa il pulsante del menu.
2. La Mini App si apre e ti riconosce dal tuo account Telegram collegato.

Se l'account non è collegato, l'app spiega di scrivere `/accedi`.

## Invitare una persona con un link

Per far entrare in un'organizzazione vera una persona che usa solo Telegram, senza email:

1. Un amministratore apre la Mini App, preme **+ → Invita una persona**, sceglie il ruolo e copia il link. Lo stesso si fa dalla dashboard, nella pagina **Persone → Invito con link Telegram**.
2. Manda il link alla persona (per esempio su WhatsApp): `https://t.me/sinfonia_coop_bot?start=i…`.
3. La persona lo apre in Telegram e preme **Avvia**: entra nell'organizzazione con quel ruolo, il suo account Telegram viene collegato e il bot le dà il benvenuto.

Il link vale 7 giorni e **una sola volta**, si può revocare finché non è usato e ogni uso resta nel registro attività. Chi l'ha già usato non può rientrare con lo stesso link.

Chi ha già un account nella dashboard collega il proprio Telegram dal **Profilo → Collega Telegram con un link** (vale 30 minuti).

## Demo per persone esterne

Per far provare SinfonIA a chi non fa parte di un'organizzazione, avvia lo staging pubblico con `--demo`:

```bash
npm run staging:start -- --public --public-url=https://<indirizzo-del-tunnel> --demo
```

Poi manda a chi vuoi il link generico:

```
https://t.me/sinfonia_coop_bot?start=demo
```

Chi lo apre e preme **Avvia** ottiene un account suo nell'organizzazione «SinfonIA Demo», con dati inventati: due pratiche agricole, documenti, una richiesta di documento e due scadenze.

- Ognuno vede solo i propri dati, mai quelli degli altri visitatori né le organizzazioni vere.
- Un account Telegram già collegato a SinfonIA non viene toccato.
- Nella demo l'assistente IA, l'assistenza, gli export e le deleghe sono spenti; comandi, documenti (OCR locale), scadenze e Mini App funzionano.
- Dopo 7 giorni l'account demo e i suoi dati vengono cancellati da soli.
- Al massimo 30 nuovi account demo all'ora.
- In produzione la demo non si può accendere.

Funziona anche scrivendo `/demo` al bot.

## 5. Finita la prova

1. Chiudi il tunnel (Ctrl+C nel suo terminale).
2. Riavvia lo staging in modalità locale (`--dashboard-login`).
3. Se l'indirizzo del tunnel non esiste più, togli il pulsante da BotFather (**Menu Button → Default**).
