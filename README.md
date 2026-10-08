# Ibero Data Server

REST API for Ibero Data. It stores organizations, datasets and Parquet files, runs analyses over them with DuckDB, publishes a public catalog, hands data off to VizCanvas, and hosts the survey harmonizer.

Built with NestJS 12, Prisma 7 on PostgreSQL 16, and DuckDB.

Related projects:

- `Ibero-data-ng`: the web app (React + Vite, port 4200).
- `vizcanvas`: the visual editor that receives data through the handoff (port 4201).

This document describes what the code does today. Business rules are listed per module. When the code and this document disagree, one of them is a bug: fix the code or update this file in the same change.

---

## Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Conventions](#conventions)
- [Users and authentication](#users-and-authentication)
- [Organizations and roles](#organizations-and-roles)
- [Datasets](#datasets)
- [Resources (Parquet files)](#resources-parquet-files)
- [Analyses](#analyses)
- [Public catalog](#public-catalog)
- [VizCanvas handoff](#vizcanvas-handoff)
- [Survey harmonizer](#survey-harmonizer)
- [File storage](#file-storage)
- [Open questions](#open-questions)

---

## Requirements

- Node `^20.19`, `^22.12` or `>=24` (required by Prisma 7).
- Docker, for the local PostgreSQL container. You can use your own PostgreSQL 16 instead (see `start:local`).

## Setup

```bash
npm install
cp .env.example .env
```

Set `JWT_SECRET` in `.env` to a long random string. The server cannot sign tokens while it is empty.

```bash
npm run start:dev
```

`start:dev` first runs `setup:dev`, which:

1. Starts the `db` container from `docker-compose.yml` (PostgreSQL 16 on host port `5433`, user/password/db `ibero`/`ibero`/`ibero_data`).
2. Generates the Prisma client.
3. Applies migrations (`prisma migrate deploy`).
4. Runs the seed, which creates the sysadmin from `SEED_ADMIN_*` if that email does not exist yet. An existing user is left untouched.

The API listens on `http://localhost:3000`. `GET /` returns `Hello World!` and works as a health check.

To use a PostgreSQL you already run, point `DATABASE_URL` at it and use `npm run start:local`, which skips Docker.

## Configuration

| Variable | Required | Default in `.env.example` | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | Local Docker database | PostgreSQL connection string. |
| `JWT_SECRET` | Yes | empty | Signs session, download and publish tokens. |
| `PORT` | No | `3000` | HTTP port. |
| `API_BASE_URL` | Yes | `http://localhost:3000` | Public URL of this API. Used to build download links sent to VizCanvas. |
| `VIZCANVAS_URL` | Yes | `http://localhost:4201` | Base URL of VizCanvas for handoff links. |
| `SEED_ADMIN_EMAIL` | No | `admin@ibero.mx` | Sysadmin created by the seed. |
| `SEED_ADMIN_PASSWORD` | No | `password123` | Sysadmin password. Change it outside local development. |
| `SEED_ADMIN_NAME` | No | `Admin Ibero` | Sysadmin display name. |

CORS is open to every origin. The `Content-Disposition` header is exposed so the web app can read download filenames.

## Scripts

| Script | What it does |
| --- | --- |
| `start:dev` / `start` | `setup:dev`, then the server in watch mode. |
| `start:local` | `setup:local` (no Docker), then the server in watch mode. |
| `start:once` | Start once, without watch and without setup. |
| `start:prod` | Run the compiled build (`node dist/main`). Run `build` first. |
| `build` | Compile to `dist/`. |
| `test` | Unit tests with Vitest. |
| `test:e2e` | End-to-end tests. Needs a running database. |
| `lint` | oxlint over `src/` and `test/`. |
| `format` | Prettier over `src/` and `test/`. |
| `prisma:migrate` | Create and apply a new migration in development. |
| `prisma:studio` | Open Prisma Studio. |

## Conventions

**Errors.** Every error response has the same shape:

```json
{ "statusCode": 409, "code": "survey_name_taken", "message": "A survey with that name already exists." }
```

- `code` is stable and meant for clients. Use it to decide what to show; do not parse `message`.
- `message` is in English and is meant for developers. The web app shows its own Spanish text.
- Validation failures use `code: "validation_error"` and add a `details` array with one string per violation, each starting with the field name (`"slug can only contain ..."`).
- Unexpected errors return `500` with `code: "internal_error"` and are logged.

**Validation.** Request bodies are validated with class-validator. Properties that are not declared in the DTO are stripped silently.

**Pagination.** List endpoints that paginate accept `limit` and `offset` and return `{ total, items }`. Unless stated otherwise, `limit` defaults to 100 and is clamped to 1–200.

**Search.** Where `q` and `term` are accepted, `q` is the main text search and each `term` (repeatable) is an extra filter. All of them must match (AND). Matching is case-insensitive.

**Identifiers.** All IDs are UUIDs. Slugs accept only lowercase letters, numbers and hyphens (`^[a-z0-9-]+$`).

---

## Users and authentication

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | none | Create an account. Returns `{ accessToken }`. |
| `POST` | `/auth/login` | none | Returns `{ accessToken }`. |
| `GET` | `/users/me` | session | Current user. |
| `GET` | `/users/me/organizations` | session | Current user's memberships, with each organization. |

Rules:

- Anyone can register. Required fields: `email` (not empty), `password` (8+ characters), `fullName` (2+ characters).
- Emails are unique. A repeated email returns `409 email_already_registered`.
- New users are never sysadmins. The only sysadmin path is the seed.
- The session token is a JWT valid for 7 days. Send it as `Authorization: Bearer <token>`.
- Login returns `401 user_not_found` when the email does not exist or the user is inactive, and `401 wrong_password` when the password is wrong.
- A user with `isActive = false` cannot log in and existing tokens stop working. There is no endpoint to change `isActive`; it is set in the database.
- Passwords are hashed with bcrypt (12 rounds).

## Organizations and roles

| Method | Path | Required role | Description |
| --- | --- | --- | --- |
| `GET` | `/organizations` | any user | List. Supports `q`, `term`, `limit`, `offset`, and `sort`: `recent` (default), `name-asc`, `name-desc`, `datasets-desc`, `members-desc`. |
| `GET` | `/organizations/recent` | any user | The 5 most recent organizations. |
| `GET` | `/organizations/:organizationId` | any user | One organization, with its members (id, email, name). |
| `POST` | `/organizations` | any user | Create. |
| `POST` | `/organizations/:organizationId/members` | `ADMIN` | Add a member or change their role. |
| `DELETE` | `/organizations/:organizationId/members/:userId` | `ADMIN` | Remove a member. |
| `DELETE` | `/organizations/:organizationId` | `ADMIN` | Delete the organization and everything in it. |

Roles inside an organization: `ADMIN`, `EDITOR`, `MEMBER`.

| Action | ADMIN | EDITOR | MEMBER |
| --- | :-: | :-: | :-: |
| Manage members, delete the organization | ✓ | | |
| Create datasets, upload resources, create and edit analyses | ✓ | ✓ | |
| Delete datasets and analyses | ✓ | | |
| Run queries, preview analyses, download files, open VizCanvas | ✓ | ✓ | ✓ |

Rules:

- Every route with `:organizationId` first checks that the organization exists and returns `404 organization_not_found` if it does not. This happens before the role check, so it applies to sysadmins too, and a missing organization never returns `403`.
- A sysadmin passes every role check in every organization.
- "Any user" means any logged-in user, member or not.
- The creator of an organization becomes its `ADMIN`.
- Organization fields: `name` (2+ characters), `slug` (unique, slug format), optional `description`. A taken slug returns `409 organization_slug_taken`.
- Organizations cannot be edited after creation.
- Adding a member who already belongs to the organization updates their role. The body is `{ userId, role }`.
- Deleting an organization deletes its members, datasets, resources and analyses, and removes their files from storage.

## Datasets

A dataset is a catalog entry inside an organization. Its data lives in resources.

| Method | Path | Required role | Description |
| --- | --- | --- | --- |
| `GET` | `/datasets` | any user | Search across all organizations. |
| `GET` | `/organizations/:organizationId/datasets` | any user | Datasets of one organization. |
| `GET` | `/organizations/:organizationId/datasets/:datasetId` | any user | One dataset with its resources and revision links. |
| `POST` | `/organizations/:organizationId/datasets` | `ADMIN`, `EDITOR` | Create. |
| `DELETE` | `/organizations/:organizationId/datasets/:datasetId` | `ADMIN` | Delete. |

Lists support `q`, `term`, `limit`, `offset`, and `sort`: `recent` (last updated, default), `title-asc`, `title-desc`, `year-desc`, `year-asc`. Search looks at title, description, source organization, exact tags, exact year and organization name.

Fields:

| Field | Rule |
| --- | --- |
| `title` | Required, 2+ characters. |
| `slug` | Required, slug format, unique across all organizations. |
| `description` | Optional. |
| `visibility` | `PUBLIC` or `PRIVATE`. Defaults to `PRIVATE`. |
| `survey` | Optional. One of `ENIGH`, `ENOE`, `INPC`, `ENADID`, `ENVIPE`, `CENSO`, `ENDUTIH`, `OTRA`. |
| `year` | Optional, 1990–2099. |
| `periodType` | Optional. `ANNUAL`, `QUARTERLY`, `MONTHLY`, `BIANNUAL`, `ONE_TIME`, `MULTIYEAR`. |
| `sourceOrg`, `licenseId` | Optional text. |
| `sourceUrl` | Optional, must be a URL. |
| `tags` | Optional list of strings. |
| `revisionOfId`, `changelog` | Optional. See revisions below. |

Rules:

- The user who creates a dataset is its owner.
- Datasets cannot be edited after creation. To publish a new version, create a revision.
- **Revisions.** Creating a dataset with `revisionOfId` makes it the next revision of that dataset:
  - The original must exist in the same organization (`400 revision_source_not_found`).
  - The original must not already have a newer revision (`400 dataset_already_superseded`). Revisions form a straight line, never a tree.
  - The new dataset gets `revision = original.revision + 1`, and the original is marked as superseded by it.
- `visibility` only affects the [public catalog](#public-catalog). Logged-in users can list and read every dataset, public or private.
- Deleting a dataset deletes its resources and analyses and their files. Revisions that pointed to it lose that link but are kept.

## Resources (Parquet files)

| Method | Path | Required role | Description |
| --- | --- | --- | --- |
| `GET` | `.../datasets/:datasetId/resources` | any user | List, newest first. |
| `POST` | `.../datasets/:datasetId/resources` | `ADMIN`, `EDITOR` | Upload a file (multipart, field `file`). |
| `POST` | `.../resources/:resourceId/query` | any role | Run a SQL query: `{ sql }`. |
| `GET` | `.../resources/:resourceId/download` | any role, download token | Download the file. |
| `GET` | `.../resources/:resourceId/vizcanvas-handoff` | any role | Get a VizCanvas link. See [handoff](#vizcanvas-handoff). |

`...` stands for `/organizations/:organizationId/datasets/:datasetId`.

Upload rules:

- Only Parquet is accepted. The name must end in `.parquet` (`400 invalid_file_extension`), and the file must start and end with the `PAR1` marker (`400 invalid_parquet_format`).
- Maximum size: 500 MB.
- The column schema (`[{ name, type }]`) is read at upload and stored. If it cannot be read, the upload still succeeds and `columns` is `null`; analyses then skip column validation.

Query rules:

- The resource is available as the table `data`.
- Only one `SELECT` or `WITH` statement is allowed. A single trailing `;` is accepted.
- These words are rejected anywhere in the query: `insert`, `update`, `delete`, `drop`, `alter`, `create`, `attach`, `detach`, `copy`, `pragma`, `install`, `load`, `export`, `import`, `call`, `set`, `grant`, `revoke`, `vacuum`, `checkpoint`, `read_parquet`, `read_csv`, `read_json`, `glob`. A column with one of these names cannot be referenced either.
- At most 10,000 rows are returned.
- Each query runs in a fresh in-memory DuckDB. File paths are removed from error messages.

## Analyses

An analysis is a saved transformation of a resource. Its result is stored as a Parquet file.

| Method | Path | Required role | Description |
| --- | --- | --- | --- |
| `GET` | `.../analyses/operations` | any user | Catalog of available steps. |
| `GET` | `.../analyses` | any user | List, newest first. |
| `GET` | `.../analyses/:analysisId` | any user | One analysis. |
| `GET` | `.../analyses/:analysisId/data` | any user | First 1,000 rows of the result. |
| `POST` | `.../analyses/preview` | any role | Run steps without saving. |
| `POST` | `.../analyses` | `ADMIN`, `EDITOR` | Create and run. |
| `PATCH` | `.../analyses/:analysisId` | `ADMIN`, `EDITOR` | Replace and rerun. |
| `DELETE` | `.../analyses/:analysisId` | `ADMIN` | Delete it and its result file. |
| `GET` | `.../analyses/:analysisId/download` | any role, download token | Download the result. |
| `GET` | `.../analyses/:analysisId/vizcanvas-handoff` | any role | Get a VizCanvas link. |
| `POST` | `.../analyses/vizcanvas` | `ADMIN`, `EDITOR`, publish token | Save an analysis built in VizCanvas. |
| `PUT` | `.../analyses/vizcanvas/:analysisId` | `ADMIN`, `EDITOR`, publish token | Update an analysis built in VizCanvas. |

Fields (create and `PATCH` take the same body; `PATCH` replaces everything):

| Field | Rule |
| --- | --- |
| `resourceId` | Required. Must belong to the same dataset. |
| `title` | Required, 2+ characters. |
| `slug` | Required, slug format, unique across all analyses (`409 analysis_slug_taken`). |
| `folder` | Required, free text used to group analyses. |
| `description` | Optional. |
| `visibility` | `PUBLIC` or `PRIVATE`. Defaults to `PRIVATE`. Stored but not used by the public catalog (see [open questions](#open-questions)). |
| `steps` | Required, at least one. Each step is `{ op, params }`. |
| `roundDecimals` | Optional, 0–15. Rounds numbers in the response. |

### Steps

| `op` | Params | Effect |
| --- | --- | --- |
| `join` | `resourceId`, `alias`, `type` (`inner` or `left`), `onLeft`, `onRight` | Joins another resource of the same dataset on `data.onLeft = alias.onRight`. |
| `compute` | `left`, `right`, `as` | New column `as = left * right`. Each operand is a column name or a number. Only multiplication is supported. |
| `filter` | `column`, `operator`, `value` | Keeps rows where the condition holds. Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`. |
| `group_by` | `columns` | Groups by one or more columns. |
| `aggregate` | `func`, `column`, `as`, `distinct` | `SUM`, `AVG`, `COUNT`, `MIN`, `MAX`, `MEDIAN`. `column` may be `*`. `distinct` needs a real column. |
| `percentage` | `of`, `as` | Adds `as` = share of the total for the aggregate named `of`. |
| `sort` | `column`, `dir` (`asc` or `desc`) | Orders the result. |
| `limit` | `n` (greater than 0) | Keeps the first `n` rows. |

Rules:

- The order of steps in the request does not matter. The SQL is always built in this order: joins, computes, filters, group by and aggregates, percentage, sort, limit. Filters therefore apply before grouping and can use computed columns.
- If several `group_by` or `percentage` steps are sent, the last one wins. `join`, `compute`, `filter`, `aggregate` and `sort` add up.
- Join aliases must be unique, and `data` is reserved (`400 duplicate_join_alias`).
- Columns are checked against the stored schemas of the source and joined resources (`400 unknown_columns`). Columns created by `compute` and `aggregate` count as known. The check is skipped when no schema is stored.
- Missing params return a specific `400` code per step, for example `filter_column_required` or `limit_rows_invalid`.
- Preview returns 100 rows by default (`sampleRows`, 1–500). A `limit` step smaller than that is respected.
- **Status.** A saved analysis goes `RUNNING` → `DONE`, or `FAILED` with `errorMessage` set. The request waits for the run to finish. `PENDING` exists in the schema but is not used.
- `data` and `download` return `400 analysis_result_not_ready` unless the status is `DONE`.
- **Origin.** Analyses built here have origin `IBERO`. Analyses saved from VizCanvas have origin `VIZCANVAS`.
  - A `VIZCANVAS` analysis cannot be edited with `PATCH` (`400 analysis_from_vizcanvas`). It is edited by opening it in VizCanvas.
  - An `IBERO` analysis cannot be updated through the VizCanvas `PUT` (`400 analysis_not_from_vizcanvas`). VizCanvas must save it as a new analysis.
- **Saving from VizCanvas.** The body is multipart: the fields above with `sourceResourceId` instead of `resourceId`, `recipe` (the canvas as a JSON string, up to 5 MB) and `file` (the result as Parquet, up to 500 MB). The server does not rerun the canvas; it stores the file it receives. Rules:
  - The recipe must have a canvas (`state.dag` with `nodes` and `edges`) and a `resultNodeId` that exists in it (`400 vizcanvas_recipe_invalid`).
  - Every table in `recipe.tables` must have a name matching `^[a-zA-Z0-9_]{1,60}$` and point to a resource of the same dataset.
  - Node results and errors are cleared before the recipe is stored.

## Public catalog

These endpoints need no login. The catalog lists **analyses**, not datasets.

An analysis is public when **its status is `DONE` and its dataset's visibility is `PUBLIC`**. The analysis' own `visibility` field is not checked.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/public/catalog` | Search. `q` (title, description), `org` (organization slug), `sort` (`recent`, `title-asc`, `title-desc`), `limit` (default 24, max 100), `offset`. |
| `GET` | `/public/catalog/:slug` | One analysis, its result schema, its steps, and the names of the source and joined resources. |
| `GET` | `/public/catalog/:slug/preview` | First rows of the result (`limit`, default and max 500). |
| `GET` | `/public/catalog/:slug/download` | Download the result. |
| `GET` | `/public/catalog/:slug/resources/:resourceId/download` | Download any resource of the analysis' dataset. |
| `GET` | `/public/catalog/:slug/vizcanvas-handoff` | VizCanvas link for an anonymous visitor. |
| `GET` | `/public/organizations` | Organizations with at least one public analysis. `q`, `sort` (`name-asc` default, `name-desc`), `limit`, `offset`. |
| `GET` | `/public/organizations/count` | Per organization slug: `sources` (datasets with public analyses) and `charts` (public analyses). |

Response shapes follow CKAN naming (`name` is the slug, `title` the display name, `notes` the description) because VizCanvas was built against CKAN.

Because the resource download is scoped to the dataset, publishing one analysis also makes every resource of that dataset downloadable.

## VizCanvas handoff

The handoff opens VizCanvas with data from this API without sharing the session token.

1. The web app calls a `vizcanvas-handoff` endpoint and gets `{ url }`.
2. The URL points to `VIZCANVAS_URL` with a one-time `handoff` code and the download links.
3. VizCanvas exchanges the code at `POST /api/3/action/duckdb_consume_handoff` with `{ token }`. This endpoint mimics CKAN: it always answers `200`, with `{ success: true, result }` or `{ success: false, error }`.
4. `result` contains the user's email and name, a `download_token`, the dataset context, and the canvas when there is one.

Tokens:

| Token | Lifetime | Use |
| --- | --- | --- |
| Handoff code | 5 minutes, single use | Exchanged once for the payload. Stored in memory: codes are lost on restart and are not shared between server instances. |
| Download token | 10 minutes | Download endpoints. They also accept the normal session token. |
| Publish token | 12 hours | Saving from VizCanvas. Only valid for the organization and dataset it was issued for (`403 publish_token_scope`). |

Download and publish tokens are checked like a session: the user must still exist and be active, and still needs the required role in the organization.

Public handoffs are issued for an anonymous visitor. They carry no publish token and their links use the public download endpoints.

## Survey harmonizer

The harmonizer lines up variables whose names change between editions of a survey (for example `age` in 2020 and `edad1` in 2021) under one canonical name, so editions can be compared over time.

Concepts:

- **Survey**: groups editions. Its name is unique.
- **Edition** (called `dataset` in the API): one uploaded CSV for one year.
- **Canonical variable**: a common name inside one survey. The same name in two surveys gives two separate variables.
- **Mapping**: "column `edad1` of this edition is canonical `edad`".

Every harmonizer endpoint needs a session, and any logged-in user can read and change every survey. Surveys do not belong to organizations.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/harmonizer/surveys` | List with editions and mapping progress. Ordered by name. `limit`, `offset`. |
| `POST` | `/harmonizer/surveys` | Create: `{ name, description? }`. |
| `GET` | `/harmonizer/surveys/:surveyId` | One survey. |
| `PATCH` | `/harmonizer/surveys/:surveyId` | Change `name` and/or `description`. |
| `DELETE` | `/harmonizer/surveys/:surveyId` | Delete the survey and everything in it, including the stored files of its editions. Returns `204`. |
| `POST` | `/harmonizer/upload` | Upload an edition (multipart). |
| `GET` | `/harmonizer/datasets/:datasetId/mapping` | Columns of an edition with saved or suggested mappings. |
| `PUT` | `/harmonizer/datasets/:datasetId/mapping` | Save the mapping of an edition. |
| `GET` | `/harmonizer/datasets/:datasetId/harmonized` | Harmonized view of one edition. |
| `GET` | `/harmonizer/datasets/:datasetId/harmonized.csv` | Same, as CSV. Also `.parquet`. |
| `GET` | `/harmonizer/surveys/:surveyId/harmonized` | Harmonized view of all editions. Optional `variables`. |
| `GET` | `/harmonizer/surveys/:surveyId/harmonized.csv` | Same, as CSV. Also `.parquet`. |

### Surveys

- The name is trimmed and cannot be empty (`400 survey_name_required`).
- Names are unique. Creating or renaming to a taken name returns `409 survey_name_taken`.
- Sending an empty `description` in `PATCH` clears it.
- Renaming a survey does not change its editions, canonical variables or mappings.
- Deleting a survey also deletes its editions, their raw rows, their mappings and its canonical variables. A missing survey returns `404 survey_not_found`. Editions cannot be deleted on their own.

### Upload

Fields: `file`, `name` (edition name, required), `year` (1900–2100), `surveyId`, and `newSurvey`.

- `surveyId` is an existing survey ID, or `__new__` to create a survey named `newSurvey` in the same request.
  - With `__new__`, `newSurvey` is required (`400 new_survey_name_required`) and must not be taken (`409 survey_name_taken`).
  - An unknown ID returns `404 survey_not_found`.
- Maximum size: 200 MB. The file extension is not checked; the content must parse as CSV (`400 csv_invalid`).
- The file must be valid UTF-8 (a BOM is allowed). Any other encoding, such as Latin-1, returns `400 csv_not_utf8` with the line of the first invalid byte, instead of storing accented characters as `�`.
- The file is checked before anything is written, so a rejected upload with `__new__` does not create the survey.
- The first row is the header. A leading BOM is removed, blank lines are skipped, and values are kept exactly as written: no trimming and no type conversion. Every value is stored as text, and empty cells are `""`.
- Headers are trimmed (leading and trailing spaces removed) before anything else. Spaces inside a name are kept.
- Repeated headers, compared after trimming, are renamed by appending `.1`, `.2`, and so on (`edad`, `edad.1`). `EDAD ` and `EDAD` become `EDAD` and `EDAD.1`.
- The header order is stored and used for column order in the harmonized view.
- All columns are stored, including those that are never mapped.
- An empty file or a header with no rows is accepted and creates an edition with 0 rows.
- The edition name, after trimming, must be unique within its survey, because it is the `_dataset` of the survey view. A repeated name returns `409 dataset_name_taken` and nothing is written. Names are compared exactly (case and accents matter).
- Uploading never changes other editions. Uploading the same file twice under two names creates two editions.

### Mapping

`GET .../mapping` returns each column with `selectedCanonicalId`, `suggested`, `suggestionSource` and `missingCodes` (the saved missing-value codes; `[]` for unsaved columns, suggestions never fill it). For each column, the first of these that applies is used:

1. **Saved**: the mapping already saved for this edition. No suggestion is shown.
2. **History** (`suggestionSource: "history"`): a column with exactly the same name was mapped in another edition of the same survey.
3. **Name** (`suggestionSource: "name"`): a canonical variable matches the column name. Names are compared after removing accents, lowercasing and turning any run of other characters into `_`. An exact match wins. Otherwise the canonical name must appear as a whole part of the column, optionally followed by digits: `edad` matches `edad1` and `edad_jefe`, but not `edades`. Ties go to the longer canonical name.
4. Otherwise the column is unmapped.

History and name suggestions never reuse a canonical variable that another column of the same edition already has (saved, or suggested to an earlier column in the header). The column is then left unmapped.

Suggestions are preselected in the response but are not saved until the client sends `PUT`.

`PUT .../mapping` takes `{ columns: [{ column, choice, newName?, newDataType?, missingCodes? }] }`:

| `choice` | Effect |
| --- | --- |
| `cv:<canonicalId>` | Map to that canonical variable. It must belong to the same survey (`400 canonical_variable_not_found`). |
| `__new__` | Map to the canonical named `newName`. It is created if it does not exist in the survey, with `newDataType` (default `text`). An empty `newName` leaves the column unmapped. |
| anything else | Leave the column unmapped. |

- `PUT` replaces the whole mapping of the edition. Columns that are left out of the request become unmapped.
- Entries for columns that are not in the edition are ignored.
- The save runs in one transaction.
- Canonical names are only trimmed. Any other text is accepted.
- `missingCodes` lists the values that mean "not specified" in that column of that edition (for example `["9", "99"]`). Codes are trimmed, and empty and repeated codes are dropped. They belong to the mapping, so each edition keeps its own codes, and unmapping the column discards them.
- Canonical variables cannot be renamed or deleted. Unmapping every column that used one does not delete it.
- Two columns of the same edition cannot use the same canonical variable, because the harmonized view has one column per canonical. Such a request returns `409 canonical_variable_collision`, the `message` lists the columns involved, and nothing is saved (including canonicals that `__new__` would have created). Two `__new__` entries with the same `newName`, or a `newName` equal to an existing canonical that another column uses, also collide.

### Harmonized views

Views are computed on every request from the edition's stored Parquet (see [File storage](#file-storage)) and its mappings. Nothing is materialized.

Edition view:

- Columns are the canonical names of the mapped columns, in header order.
- An edition with no mappings has no columns and no rows.
- **Missing values.** A value is `null` when the cell is empty, contains only spaces, or, once trimmed, equals one of the column's `missingCodes`. Every other value, `0` included, is returned exactly as stored. The stored rows are never changed, so editing the codes changes the view right away.

Survey view:

- `variables` picks the canonical variables to include. It can be repeated or comma-separated. Without it, the view includes every canonical variable that has at least one mapping, in alphabetical order.
- Editions are stacked by year, then by upload time.
- Every row gets `_dataset` (edition name), `_year` and `_row`. `_row` is the record number in the uploaded file, starting at 1 with the first row after the header. It counts records, not lines, so a value with a line break does not shift it.
- `_dataset` + `_row` identifies every row, even when the file has no ID column or repeats IDs across editions. Columns from the file, such as a person ID, are usually repeated across editions, so joining on them alone duplicates rows.
- A variable that an edition does not have is missing from that edition's rows.
- Missing values keep the codes of their own edition: a `9` is `null` only in editions where `9` is a missing code for that column.
- Rows that have none of the selected variables are dropped.

Exports:

- Formats: `csv` and `parquet`. Any other extension returns `404 export_format_not_supported`.
- The filename is `harmonized_<edition>_<year>` or `harmonized_<survey>`, with accents and symbols removed.
- The survey export puts `_dataset`, `_year` and `_row` first. The edition export does not include them.
- CSV is UTF-8 with a BOM, so Excel opens it correctly. Missing values are empty.
- Parquet columns are all text. Missing values are `NULL`, so they are distinct from any text value.
- Exporting an edition with no mappings as Parquet returns `400 harmonized_view_empty`.

## File storage

Files are written to `storage/` under the directory the server is started from. The folder is ignored by git.

| Path | Content |
| --- | --- |
| `storage/<datasetId>/<uuid>-<filename>` | Uploaded resources. Unsafe characters in the name become `_`. |
| `storage/analyses/<analysisId>.parquet` | Analysis results. |
| `storage/harmonizer/<datasetId>.parquet` | Rows of a harmonizer edition, all text, in file order. Columns are positional (`c0`, `c1`, …); their names are the edition's stored headers. An empty file (no header) writes no Parquet. |

Deleting through the API removes the related files. A file deleted by hand makes its resource return `404 resource_file_missing`, and makes the views and exports of its harmonizer edition return `404 harmonizer_dataset_file_missing`.

---

## Open questions

The code currently behaves as described below. It is not yet decided whether each behavior is intended. When one is decided, update the relevant section and remove it from this list.

- **Analysis visibility.** The public catalog ignores `Analysis.visibility` and uses only the dataset's visibility. A `PRIVATE` analysis in a `PUBLIC` dataset is public.
- **Private datasets.** `PRIVATE` only hides a dataset from the public catalog. Any logged-in user can still list and read it.
- **Harmonizer access.** Surveys are not tied to organizations, so every logged-in user can read and change all of them.
- **Empty CSV uploads.** Files with no rows are accepted (report H-08).
- **Canonical variable names.** They are not validated and cannot be renamed or deleted (report H-20).
- **Column collisions.** Two columns mapped to one canonical variable keep only the later one, without a warning (report H-01).
- **Login errors.** Different codes for an unknown email and a wrong password reveal which emails are registered.
- **Email format.** Registration only requires a non-empty email; the format is not checked.
- **Unused pieces.** `SysadminGuard` and the `PENDING` analysis status exist but are not used.
