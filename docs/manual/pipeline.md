# Pipeline

Every live job, one row each, soonest install first, one cell per stage: Drafting, Check measure, Drawings, Materials, Factory, Painting, Delivery, Install, Stone, and open rework.

## Reading a cell

| Cell | Means |
|---|---|
| Green, ✓ | Done |
| Amber | On this week |
| Grey with a date | Later |
| Red | Overdue: the date has passed and nobody ticked it |
| Dashed, ? | No date |
| – | Skipped: undated but a later stage is done (the imported jobs never had Drafting ticked) |
| Blank | Not on this job (no painting, no stone) |

The **dark outline** is the stage the job is at: the first one not ticked done. The dot on the Materials cell is readiness: green ready to cut, amber on order, red short or on order for after the factory date. The count under each column heading is how many jobs are at that stage.

Tap a cell to open that step on the job. On a phone each job is a card with its stages as chips.
