# Data agent

The knowledge layer. A single BigQuery table plus a Conversational Analytics
agent that answers natural-language questions strictly from that table.

This section is written generically — the running example is a table of
**Widgets** with pricing bands. Swap "widget" for your own noun and it works
for any domain.

## What you're building

A published data agent that:
- Only answers from rows in your BigQuery table.
- Follows a fixed set of verified queries for the questions it will be asked
  most often.
- Maps user phrasing (synonyms, abbreviations) to the right columns via a
  glossary.
- Refuses to invent items or figures that are not in the table.

The orchestrator (next section) treats this agent as its **sole source of
facts**. Anything the model wants to state — a category, a price, a location
— must have come back from this agent.

## Prerequisites

- A GCP project with billing enabled.
- BigQuery API + Conversational Analytics enabled:
  ```bash
  gcloud services enable bigquery.googleapis.com geminidataanalytics.googleapis.com
  ```

## Step 1 — Design the table

You want **one row per fact**. Wide, flat, denormalised. This makes the agent's
job easy: it never needs to join, it just filters and returns rows.

For a pricing/salary/rating domain, a good shape is:

| Column       | Type     | What it holds                                       |
|--------------|----------|-----------------------------------------------------|
| `Sector`     | STRING   | Top-level grouping (industry, product line, region) |
| `Subsector`  | STRING   | Subdivision of the sector                           |
| `Category`   | STRING   | Family grouping of related items                    |
| `Item`       | STRING   | The canonical name. **Only these values are valid.**|
| `Notes`      | STRING   | Description of the item — used for matching         |
| `Location`   | STRING   | Geography the figures apply to                      |
| `Typical`    | STRING   | Accepted mid/median value (parsed as a number)      |
| `Range Low`  | FLOAT    | Lower bound                                         |
| `Range High` | INTEGER  | Upper bound                                         |

Rules of thumb:
- **The `Item` column is the identity column.** The agent will refuse to name
  any item not present in it. Get it clean.
- **Denormalise location.** Duplicate rows per location rather than joining a
  location table. Each row = one item in one place.
- **Store a median.** If you have one, put it in `Typical`. Otherwise the agent
  can compute `(low + high) / 2`, but a stored median is more accurate and lets
  users trust the middle number.
- **Currency is implied by `Location`.** Don't store a currency column; derive
  it in queries and the system instructions.

## Step 2 — Load the data

Any path works — CSV upload in the console, `bq load`, or a scheduled query
from a source system. What matters is:
- One row per (item, location).
- No duplicate `Item` values within a single location (or if there are — e.g.
  two seniority levels — add a column to disambiguate).
- Consistent formatting in `Typical` (either always `120000` or always
  `$120,000` — the regex-parse below handles both, but not shorthand like
  `120k`).

Confirm with a couple of sanity checks:

```sql
SELECT COUNT(*) AS total_rows,
       COUNT(DISTINCT Item) AS distinct_items,
       COUNT(DISTINCT Location) AS distinct_locations
FROM `PROJECT.DATASET.TABLE`;

SELECT Item, Location, COUNT(*) AS n
FROM `PROJECT.DATASET.TABLE`
GROUP BY 1, 2
HAVING n > 1;
```

The second query should return zero rows. If not, decide whether duplicates
are legitimate (different seniority tiers, say) and add a column, or dedupe.

## Step 3 — Create the agent

Console: **BigQuery → Agents → Create agent**.
- **Type**: Data agent (Conversational Analytics).
- **Location**: pick a region and stick to it. Once saved, the location is
  fixed. Older agents may sit in `global`.
- **Data source**: the table you just built.

Once saved, record the agent's **resource ID** — it's the last segment of its
resource path:
`projects/.../locations/LOCATION/dataAgents/`**`THIS-PART`**.

You'll set this as `DATA_AGENT_ID` in the orchestrator.

## Step 4 — System instructions

Paste the block below into the agent's system-instructions field. Replace
`Widgets` / `widget` with your domain noun. The rules protect against the
failure modes we hit repeatedly during development:

```
You are a data agent for the Widgets table. Your only source of truth is the
BigQuery table PROJECT.DATASET.TABLE. Answer questions strictly from that
table.

DATA MODEL
- Each row describes one Item within a Category, Subsector and Sector, for
  one Location.
- The range for a row runs from `Range Low` to `Range High`. `Typical` holds
  an accepted median value, stored as a string.
- Parse `Typical` as a number:
    SAFE_CAST(REGEXP_REPLACE(Typical, r'[^0-9.]', '') AS FLOAT64)
  Use it as the "mid" value of the range. If `Typical` is null or unparseable,
  fall back to (`Range Low` + `Range High`) / 2.
- `Notes` describes the item; use it to match a user's description to items
  that exist in the table.

CURRENCY (or unit of measure)
- Derive from `Location`. Adjust the mapping to your data.
- Never convert between units. Report figures exactly as stored.

HARD RULES
1. Use only data found in the table. Never use general knowledge for items,
   descriptions, prices, sectors, or locations.
2. Every Item you name must exist exactly in the `Item` column. If asked
   about an item that is not present, say it is not in the dataset, then list
   the closest items that ARE present.
3. Never invent, estimate, or round-to-a-nicer-number. Report only what is
   stored (or the computed midpoint from real endpoints).
4. Always present figures as a range with its unit and Location. Do not give
   a single number without its range.
5. When matching a user's description to items, only return items that exist,
   and justify the match using `Notes` and/or `Category`. If nothing is a
   reasonable match, say so explicitly.
6. If an Item has multiple Locations, return each Location separately. Never
   average across Locations.
7. If the requested data is missing, partial, or ambiguous, say exactly what
   is missing. Do not fill gaps with assumptions.

OUTPUT STYLE
- Prefer returning rows a caller can parse: Item, Location, Category,
  range_low, range_mid, range_high, unit, notes.
- Be concise. State the SQL basis when helpful.
```

## Step 5 — Verified queries

Add each of these as a **verified query** on the agent. Verified queries are
the consistency mechanism: because they're parameterised templates, the same
question always produces the same SQL against the same columns.

Replace `PROJECT.DATASET.TABLE` in every query.

### VQ1 — Range for a specific item (all locations)
Example: "What's the range for Widget X?", "How much is the ACME Sprocket?"

```sql
SELECT
  Item,
  Location,
  Category,
  Subsector,
  Sector,
  CAST(`Range Low`  AS FLOAT64) AS range_low,
  CAST(`Range High` AS FLOAT64) AS range_high,
  COALESCE(
    SAFE_CAST(REGEXP_REPLACE(Typical, r'[^0-9.]', '') AS FLOAT64),
    ROUND((CAST(`Range Low` AS FLOAT64) + CAST(`Range High` AS FLOAT64)) / 2)
  ) AS range_mid,
  Notes
FROM `PROJECT.DATASET.TABLE`
WHERE LOWER(Item) = LOWER(@item)
ORDER BY Location;
```

### VQ2 — Range for an item in a specific location

```sql
SELECT
  Item,
  Location,
  CAST(`Range Low`  AS FLOAT64) AS range_low,
  CAST(`Range High` AS FLOAT64) AS range_high,
  COALESCE(
    SAFE_CAST(REGEXP_REPLACE(Typical, r'[^0-9.]', '') AS FLOAT64),
    ROUND((CAST(`Range Low` AS FLOAT64) + CAST(`Range High` AS FLOAT64)) / 2)
  ) AS range_mid
FROM `PROJECT.DATASET.TABLE`
WHERE LOWER(Item) = LOWER(@item)
  AND LOWER(Location) LIKE CONCAT('%', LOWER(@location), '%')
ORDER BY Location;
```

### VQ3 — Match user description to items (the key one)
This is what the orchestrator uses to turn "I do X and Y" into a list of items
that actually exist. Only real items can come back.

```sql
SELECT
  Item,
  Category,
  Sector,
  Location,
  Notes,
  CAST(`Range Low`  AS FLOAT64) AS range_low,
  CAST(`Range High` AS FLOAT64) AS range_high
FROM `PROJECT.DATASET.TABLE`
WHERE LOWER(Item)     LIKE CONCAT('%', LOWER(@keyword), '%')
   OR LOWER(Notes)    LIKE CONCAT('%', LOWER(@keyword), '%')
   OR LOWER(Category) LIKE CONCAT('%', LOWER(@keyword), '%')
ORDER BY Item, Location;
```

### VQ4 — List items that exist (seed suggestions / existence check)
Used when the user doesn't know what to call their thing. Also used by the
orchestrator to cache a list of common items to offer up-front.

```sql
SELECT DISTINCT Sector, Category, Item
FROM `PROJECT.DATASET.TABLE`
ORDER BY Sector, Category, Item;
```

### VQ5 — Items within a sector or category

```sql
SELECT DISTINCT Sector, Subsector, Category, Item
FROM `PROJECT.DATASET.TABLE`
WHERE (@sector   = '' OR LOWER(Sector)   LIKE CONCAT('%', LOWER(@sector),   '%'))
  AND (@category = '' OR LOWER(Category) LIKE CONCAT('%', LOWER(@category), '%'))
ORDER BY Sector, Subsector, Category, Item;
```

### VQ6 — Compare one item across locations

```sql
SELECT
  Location,
  CAST(`Range Low`  AS FLOAT64) AS range_low,
  CAST(`Range High` AS FLOAT64) AS range_high,
  COALESCE(
    SAFE_CAST(REGEXP_REPLACE(Typical, r'[^0-9.]', '') AS FLOAT64),
    ROUND((CAST(`Range Low` AS FLOAT64) + CAST(`Range High` AS FLOAT64)) / 2)
  ) AS range_mid
FROM `PROJECT.DATASET.TABLE`
WHERE LOWER(Item) = LOWER(@item)
ORDER BY Location;
```

### VQ7 — Distinct sectors / categories (navigation + validation)

```sql
SELECT DISTINCT Sector, Subsector, Category
FROM `PROJECT.DATASET.TABLE`
ORDER BY Sector, Subsector, Category;
```

### Testing verified queries in the BigQuery console

The `@param` form only works when the *agent* is calling the query — a bare
paste into the SQL editor errors with "parameter @item not found." For quick
tests, wrap the query with `DECLARE`:

```sql
DECLARE item STRING DEFAULT 'Widget X';   -- pick a real value from VQ4

SELECT ... FROM `PROJECT.DATASET.TABLE`
WHERE LOWER(Item) = LOWER(item);          -- note: bare `item`, no @
```

When moving back to the agent, delete the `DECLARE` line and put the `@`
back on the variable.

## Step 6 — Glossary

Glossary terms map user phrasing to your columns and concepts. Two rules:

1. **Point at columns, not at guessed items.** Terms like "price", "cost",
   "how much" all map to the `Range Low` / `Range High` / `Typical` fields.
   Safe — they don't depend on any specific item existing.
2. **Item-name synonyms must reference real items.** If you add a synonym
   like `"dev" → "Software Engineer"` but "Software Engineer" isn't in your
   `Item` column, you've just taught the agent to hallucinate. Always run VQ4
   first to get the exact list of real items, then only add synonyms that
   point to those.

Starter set (generic — adapt terms to your domain):

| User phrasing                            | Meaning                                              |
|------------------------------------------|------------------------------------------------------|
| price, cost, rate, value, worth          | The numeric figures for an Item+Location             |
| range, band                              | The span from `Range Low` to `Range High`            |
| low end, minimum, floor, entry, starting | `Range Low`                                          |
| high end, maximum, ceiling, top          | `Range High`                                         |
| mid, midpoint, median, typical, average  | Parsed `Typical` (fallback: computed midpoint)       |
| item, product, thing, model              | `Item`                                               |
| family, discipline, group                | `Category`                                           |
| industry, area, field                    | `Sector`                                             |
| description, what it does, features      | `Notes`                                              |

## Step 7 — Publish the agent

Console: **Agent details → Publish**. Publishing makes it callable from the
Conversational Analytics API, which is how the orchestrator reaches it.

Verify from the BigQuery agent chat panel that questions return sensible
answers before wiring the orchestrator. Ask each of the questions listed
against your verified queries. If any produces a wrong answer, the fix is
usually in the verified query, not the model.

## What the orchestrator will need from you

Once this section is done, note these values — the orchestrator will read them
from environment variables:

- **Project ID** — of the GCP project holding the dataset and agent.
- **Data agent location** — the region you picked at agent creation, or
  `global` for older agents.
- **Data agent ID** — the last segment of the agent's resource path.

Move on to [`orchestrator/README.md`](../orchestrator/README.md).
