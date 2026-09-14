# Edsby Bridge

Keeps a signed-in Edsby session on your Home Assistant server and sends what
your classes post — feeds, assignments, tests, calendar — to your DayFlow relay.

## Setting it up

1. **Configuration tab.** Paste your relay secret into `relay_secret` and save.
   `edsby_host` is your school's Edsby address (for TanenbaumCHAT,
   `tchat.edsby.com`). Leave `relay_url` as it is.
2. **Start** the add-on. The first start builds it on your server, which takes a
   few minutes, longer on a Raspberry Pi.
3. **Sign in.** Open the **Edsby** panel in the sidebar (or *Open Web UI*). You
   will see a browser on Edsby's sign-in page. Sign in exactly as you normally
   would, including a school Google or Microsoft account if that is how you log
   in. Then click into one or two of your classes so it sees what they load.
4. Done. The session is kept, and the add-on looks again every few hours
   (`interval_minutes`, 180 by default).

## What it sends, and what it never does

It records the data Edsby's own web app loads for you, as the app receives it.
It never reads anything you type, so your password does not pass through it.
It does not record sign-in or session responses, and it replaces any value
named like a secret (password, token, ticket, session, cookie) before sending.

It only looks every few hours, the same as a person checking once in a while.

## If it stops

The **Log** tab says what happened. `signed in: no` means Edsby ended the
session: open the panel and sign in again.
