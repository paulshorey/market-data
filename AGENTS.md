# Market Data back-end

This NodeJS app will run continuously, polling APIs every 10 seconds for new futures and crypto prices and statistics. It will filter, aggregate and format the data, and save the analysis to our own database.

It will also serve the aggregated formatted data via APIs for use by web apps and bots.

## Hosting Platform

[Railway](https://railway.com)

Documentation about Railway is available locally in this codebase, inside the "docs" folder. When you need to know how to configure or deploy something, read the many .md files inside ./docs folder.
