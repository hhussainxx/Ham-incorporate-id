# ham-incorporate-id

a centralised custom game relay for (omega strikers) custom lobbies.

## why this exists
i was a norms player for a long time. about a year ago, when chaos mode released, norms, in eu, effectively died. ranked was never something i enjoyed, so the options were 'ither stop playing or rely on custom games.
i ended up making a discord server for customs after multiple people asked for one but didnt want to run it themselves. that server has existed for around two years now.
over time, a question kept coming up: what actually makes this server different?
most servers already have a custom games role you can ping. the "problem" is-that, every server is isolated. players sit in a servers, sometimes, pings get missed and lobbies often die early, especially in smaller communities.

the idea behind ham-incorporate-id is simple:
instead of every server shouting into its own corner, connect them. if they want. 

i respect your privacy; most servers create a separate role specifically for this system, because, they would rather prioritise pinging their own community first; each server has its own atmosphere and culture, which attracts certain types of members. they dont want to ping my server, without the members building trust. not just to my bot but-also to my members it brings.
the goal is not to replace individual servers, but to give them a wider pool to fall back on when they need it.

## what the bot does
- listens for custom game pings and player counts in partnered servers
- creates a temporary relay channel in the central server: omega strikers, customs games.
- mirrors lobby status and player counts
- automatically closes the channel once the lobby is full or inactive

the goal is not to replace how servers run customs, but to **amplify** them by sharing visibility across communities.

## design philosophy
- private lobbies stay private
- the bot only relays information players already choose to share
- api data is used when available, but message parsing is kept as a fallback
- reliability over cleverness

## current status
this bot is actively used and evolving.
the code is public for transparency and trust, not because it is a plug and play solution.

## setup notes
this repository does not include:
- tokens
- private configs
- server specific ids
you will need to provide your own `.env` and `config.json`.

## disclaimer
this is a community project built to solve a specific problem. its not affiliated with odyssey interactive or clarion corp.
