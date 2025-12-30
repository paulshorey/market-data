# Overview

This is defunct, not used. No QuestDB connected. This documentation is only for historical and future use.

# Warning:

The web interface for my new QuestDB shows this warning. The DB was set up automatically by my hosting provider Railway, with default settings.

Warning:vm.max_map_count limit is too low [current=65530, recommended=1048576]

Max virtual memory areas limit:
https://questdb.io/docs/deployment/capacity-planning/#max-virtual-memory-areas-limit

My database table will be hundreds of millions of rows, with 1-minute timestamps. It won't be anything extreme like billions of rows or microseconds.

Should I ignore this warning? Or what should I do to fix it?

# Answer:

Railway created the QuestDB deployment with default settings.

This warning is worth addressing, but you likely can't fix it yourself on Railway—it requires host-level kernel access that containerized platforms typically don't expose.

## What this means

`vm.max_map_count` limits how many memory-mapped file regions a process can use. QuestDB memory-maps columns within each partition for fast access. Your setup will use roughly:

```
240 partitions (20 years × 12 months) × 7 columns × ~2-3 mappings each
≈ 3,000-5,000 mappings
```

You're well under the 65,530 limit for a single table with your described workload. **You probably won't hit this limit soon.**

## When it becomes a problem

You'd approach the limit if you add more tables, significantly more tickers, or much finer partitioning. Symptoms when exceeded: queries fail, new partitions can't be created, or the database refuses to start.

## What to do

**Option 1: Monitor and proceed (recommended for now)**

Your single-table use case with monthly partitions should be fine. Keep an eye on it—if you start seeing memory-mapping errors in logs, then escalate.

**Option 2: Contact Railway support**

Ask if they can increase `vm.max_map_count` on the host or provide a configuration option. The fix is a single command on the host:

```bash
sysctl -w vm.max_map_count=1048576
```

Some managed platforms accommodate this for databases that need it (Elasticsearch has the same requirement).

**Option 3: Move to a VPS if it becomes blocking**

If Railway can't adjust it and you hit limits, a basic VPS (Hetzner, DigitalOcean, etc.) gives you full control. QuestDB runs well on modest hardware—4 vCPUs and 16GB RAM would handle your dataset comfortably.

## Bottom line

For hundreds of millions of rows in one table with monthly partitions, you're likely fine. The warning is conservative. Proceed with your setup, but file a support ticket with Railway asking about the setting so you know your options before it matters.
