# Ibero Data Server

REST API for Ibero Data. It stores organizations, datasets and Parquet files, runs analyses over them with DuckDB, publishes a public catalog, hands data off to vistrace, and hosts the survey harmonizer.

Built with NestJS 12, Prisma 7 on PostgreSQL 16, DuckDB, and BullMQ on Redis for background jobs.

Related projects:

- `Ibero-data-ng`: the web app (React + Vite, port 4200).
- `vistrace`: the visual editor that receives data through the handoff (port 4201).

This document describes what the code does today. Business rules are listed per module. When the code and this document disagree, one of them is a bug: fix the code or update this file in the same change.

---

## Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Conventions](#conventions)
- [Background jobs](#background-jobs)
- [Users and authentication](#users-and-authentication)
- [Organizations and roles](#organizations-and-roles)
- [Datasets](#datasets)
- [Resources (Parquet files)](#resources-parquet-files)
- [Analyses](#analyses)
- [Public catalog](#public-catalog)
- [vistrace handoff](#vistrace-handoff)
- [Survey harmonizer](#survey-harmonizer)
- [File storage](#file-storage)
- [Open questions](#open-questions)

---

## Requirements

- Node `^20.19`, `^22.12` or `>=24` (required by Prisma 7).
- Docker, for the local PostgreSQL and Redis containers. You can use your own PostgreSQL 16 instead (see `start:local`).
- Redis 6.2 or later for the background jobs (the container uses Redis 7.4). It must keep every key (`maxmemory-policy noeviction`), as BullMQ requires.

## Setup

```bash
npm install
cp .env.example .env
```

Set `JWT_SECRET` in `.env` to a long random string. The server cannot sign tokens while it is empty.

`xlsx` (SheetJS, used to read harmonizer dictionaries) is installed from `vendor/xlsx-0.20.3.tgz`, the official tarball from `cdn.sheetjs.com`. The `xlsx` package on the npm registry stopped at 0.18.5, which has known vulnerabilities (CVE-2023-30533, CVE-2024-22363), and npm 12 refuses to install packages from a URL by default, so the tarball is kept in the repository. To upgrade, download the new tarball from `https://cdn.sheetjs.com/`, put it in `vendor/` and run `npm install --save ./vendor/<file>.tgz`.

```bash
npm run start:dev
```

`start:dev` first runs `setup:dev`, which:

1. Starts the `db` and `redis` containers from `docker-compose.yml`: PostgreSQL 16 on host port `5433` (user/password/db `ibero`/`ibero`/`ibero_data`) and Redis 7.4 on host port `6380`, with `appendonly` on so queued jobs survive a restart.
2. Generates the Prisma client.
3. Applies migrations (`prisma migrate deploy`).
4. Runs the seed, which creates the sysadmin from `SEED_ADMIN_*` if that email does not exist yet. An existing user is left untouched.

The API listens on `http://localhost:3000`. `GET /` returns `Hello World!` and works as a health check.

To use a PostgreSQL you already run, point `DATABASE_URL` at it and use `npm run start:local`, which skips Docker.

Background jobs run in a separate process, the worker (see [Background jobs](#background-jobs)). Start it in a second terminal:

```bash
npm run start:worker
```

`npm run jobs:check` checks that the queue and the worker work: it adds a test job, waits for the worker to run it and prints the worker's pid and DuckDB settings.

## Configuration

| Variable | Required | Default in `.env.example` | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | Local Docker database | PostgreSQL connection string. |
| `JWT_SECRET` | Yes | empty | Signs session, download and publish tokens. |
| `PORT` | No | `3000` | HTTP port. |
| `API_BASE_URL` | Yes | `http://localhost:3000` | Public URL of this API. Used to build download links sent to vistrace. |
| `VISTRACE_URL` | Yes | `http://localhost:4201` | Base URL of vistrace for handoff links. |
| `SEED_ADMIN_EMAIL` | No | `admin@ibero.mx` | Sysadmin created by the seed. |
| `SEED_ADMIN_PASSWORD` | No | `password123` | Sysadmin password. Change it outside local development. |
| `SEED_ADMIN_NAME` | No | `Admin Ibero` | Sysadmin display name. |
| `REDIS_URL` | No | `redis://localhost:6380` | Redis for the background jobs (`redis://` or `rediss://`). |
| `WORKER_CONCURRENCY` | No | `1` | Jobs a worker process runs at once. |
| `DUCKDB_MEMORY_LIMIT` | No | `4GB` | DuckDB memory limit in the worker, in any unit DuckDB accepts (`4GB`, `512MiB`). |
| `DUCKDB_THREADS` | No | `4` | DuckDB threads in the worker. |
| `DUCKDB_TEMP_DIR` | No | empty (`<OS temp>/ibero-duckdb`) | Where DuckDB in the worker spills to disk when a job does not fit in memory. Created if missing. |
| `API_DUCKDB_MEMORY_LIMIT` | No | `2GB` | DuckDB memory limit in the API, **per query**: each query (mapping checks, views, analyses, exports) opens its own DuckDB, so this caps each one, not the API as a whole. A query that needs more spills to `API_DUCKDB_TEMP_DIR`; if it still does not fit, it fails with `400` instead of taking the server's memory. A value DuckDB rejects stops the API at startup. |
| `API_DUCKDB_THREADS` | No | `4` | DuckDB threads per query in the API. |
| `API_DUCKDB_TEMP_DIR` | No | empty (`<OS temp>/ibero-duckdb-api`) | Where DuckDB in the API spills to disk. Created if missing; each query uses its own folder inside it and deletes it when done. |
| `UPLOAD_DIR` | No | empty (`storage/uploads`) | Where harmonizer uploads arrive through tus, until the worker imports them. |
| `UPLOAD_MAX_BYTES` | No | `10737418240` (10 GiB) | Largest harmonizer upload through tus. |
| `UPLOAD_MAX_UNCOMPRESSED_BYTES` | No | `UPLOAD_MAX_BYTES` | Largest CSV inside a `.csv.gz` upload, once decompressed. By default a `.csv.gz` cannot hold more than could be uploaded uncompressed: compressing makes the upload faster, it does not raise the limit. |
| `DBF_MAX_BYTES` | No | `209715200` (200 MiB) | Largest DBF upload: a DBF is read whole into the worker's memory. |
| `UPLOAD_EXPIRATION_HOURS` | No | `24` | An unfinished upload is deleted this long after it started. |

CORS is open to every origin. The `Content-Disposition` header is exposed so the web app can read download filenames.

## Scripts

| Script | What it does |
| --- | --- |
| `start:dev` / `start` | `setup:dev`, then the server in watch mode. |
| `start:local` | `setup:local` (no Docker), then the server in watch mode. |
| `start:once` | Start once, without watch and without setup. |
| `start:prod` | Run the compiled build (`node dist/main`). Run `build` first. |
| `start:worker` | The worker process in watch mode. It compiles to `dist-worker/`, because the API's watch mode deletes `dist/` on every rebuild. |
| `start:worker:prod` | Run the compiled worker (`node dist/worker`). Run `build` first. |
| `jobs:check` | Add a test job and wait for a worker to run it. Uses `dist/` (built by `start:dev` or `build`). |
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
{ "statusCode": 409, "code": "survey_name_taken", "message": "A survey named \"ENIGH\" already exists.", "params": { "name": "ENIGH" } }
```

- `code` is stable and meant for clients. Use it to decide what to show; do not parse `message`.
- `message` is human-readable and always in English, for developers and logs. The server never answers in Spanish: clients show their own text for each `code`, and the web app translates it to Spanish.
- `params`, when present, carries the values a client needs to build its own message (names, line numbers, offending values), so it never has to parse `message`. Each error that has `params` documents them below or in its module section.
- DuckDB failures in analyses and queries (`recipe_execution_failed`, `query_execution_failed`, `schema_read_failed`, `parquet_read_failed`, `parquet_write_failed`) also carry `reason` and, for some reasons, `params`, so the client can explain the problem without parsing `message`. `reason` is one of `invalid_value` (`params: { value, expectedType }`, where `expectedType` is `integer`, `number`, `date`, `timestamp`, `boolean` or `other`), `unknown_column` (`params: { column }`), `incompatible_types`, `syntax_error`, `unknown_table`, `out_of_memory`, `io_error` or `unknown`. The `message` never includes SQL, file paths or DuckDB's own text; the raw DuckDB error is logged on the server.
- Validation failures use `code: "validation_error"` and add a `details` array with one string per violation, each starting with the field name (`"slug can only contain ..."`).
- Unexpected errors return `500` with `code: "internal_error"` and are logged.
- When two requests race on the same record (for example, the same `DELETE` sent twice at once), the one whose write no longer finds the record returns `404` instead of `500`. Its `code` is the same one the endpoint uses for a missing record (`harmonizer_dataset_not_found`, `survey_not_found`, `dataset_not_found`, `resource_not_found`, `analysis_not_found`, `organization_not_found`, `canonical_variable_not_found`), or `not_found` for other records. The `message` is "The record no longer exists. Another request may have deleted it at the same time." The global exception filter does this for Prisma's `P2025` error and logs it as a warning.

**Validation.** Request bodies are validated with class-validator. Properties that are not declared in the DTO are stripped silently.

**Pagination.** List endpoints that paginate accept `limit` and `offset` and return `{ total, items }`. Unless stated otherwise, `limit` defaults to 100 and is clamped to 1–200.

**Search.** Where `q` and `term` are accepted, `q` is the main text search and each `term` (repeatable) is an extra filter. All of them must match (AND). Matching is case-insensitive.

**Stopping.** On `SIGTERM` or `SIGINT` (also when watch mode restarts it) the API runs its shutdown hooks before exiting: it closes the HTTP server, the connections to PostgreSQL and Redis, and deletes the files of prepared downloads (see [Direct downloads](#direct-downloads)). Open connections are cut, not waited for: a download being sent stops half way, and a tus upload loses only the chunk being sent: the web app retries for about 20 seconds and continues from the last byte stored if the API is back by then. The worker stops differently (see [Background jobs](#background-jobs)).

**Identifiers.** All IDs are UUIDs. Slugs accept only lowercase letters, numbers and hyphens (`^[a-z0-9-]+$`).

---

## Background jobs

Heavy work runs outside the API, in a worker process (`src/worker.ts`), so a job that runs out of memory cannot take the API down. The API adds jobs to a queue in Redis with BullMQ, and the worker takes them from there.

- There is one queue, `ibero-jobs`, for every kind of job. A worker runs `WORKER_CONCURRENCY` jobs at once (1 by default), whatever their kind, so it never runs two heavy DuckDB jobs at the same time unless told to.
- Jobs and their payloads are typed in `src/modules/jobs/job-types.ts`. The API adds them with `JobsService` (`src/modules/jobs/`); each name has a handler in `src/worker/job-handlers.ts`, and a name without a handler does not compile.
- Each job runs once (`attempts: 1`): a job that fails because of its input would fail again. A job with no handler fails without retrying. If the worker dies while running a job, BullMQ hands the job to a worker again once.
- Completed jobs are kept 7 days and failed jobs 30 days (at most 1,000 of each), so their status can still be read; then Redis removes them.
- A job added while no worker is running waits in Redis and runs when a worker starts. Redis keeps it across a restart.
- DuckDB in the worker uses `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS` and `DUCKDB_TEMP_DIR`. The worker opens DuckDB with them when it starts and exits with an error if DuckDB rejects a value, instead of failing every job. Invalid `WORKER_CONCURRENCY`, `DUCKDB_THREADS` or `REDIS_URL` values also stop it at startup. The `AnalysisService` used inside the worker (column profiles and column type checks) uses them too. The API's own DuckDB queries (analyses, harmonizer views and mapping) use `API_DUCKDB_*` instead. In both processes every DuckDB spills to its own folder inside the temp directory, because two DuckDBs spilling to the same folder at once overwrite each other's files.
- If Redis is down, the worker waits and connects when it comes back. Redis errors are logged at most once every 30 seconds.
- On `SIGTERM` or `SIGINT` the worker stops taking jobs and waits for the running ones to finish before exiting.
- Jobs: `harmonizerImport` (see [Imports](#imports); its job id is the import id) and `diagnostic`, used by `npm run jobs:check`.
- The API connects to Redis to add jobs. Without the worker running, uploads arrive but stay `PENDING` until it starts.

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
| Run queries, preview analyses, download files, open vistrace | ✓ | ✓ | ✓ |

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
| `POST` | `.../datasets/:datasetId/resources/from-harmonizer` | `ADMIN`, `EDITOR` | Save a harmonized view of the survey harmonizer as a resource. See [From the harmonizer](#from-the-harmonizer). |
| `POST` | `.../resources/:resourceId/query` | any role | Run a SQL query: `{ sql }`. |
| `GET` | `.../resources/:resourceId/download` | any role, download token | Download the file. |
| `GET` | `.../resources/:resourceId/vistrace-handoff` | any role | Get a vistrace link. See [handoff](#vistrace-handoff). |

`...` stands for `/organizations/:organizationId/datasets/:datasetId`.

Upload rules:

- Only Parquet is accepted. The name must end in `.parquet` (`400 invalid_file_extension`), and the file must start and end with the `PAR1` marker (`400 invalid_parquet_format`).
- Maximum size: 500 MB.
- The column schema (`[{ name, type }]`) is read at upload and stored. If it cannot be read, the upload still succeeds and `columns` is `null`; analyses then skip column validation.

### From the harmonizer

`POST .../resources/from-harmonizer` takes `{ editionId }` (one edition) or `{ surveyId, variables? }` (the survey view, `variables` as in its download) and saves that harmonized view as a Parquet resource of the dataset. Anything else returns `400 harmonized_source_invalid`.

- The file is exactly the Parquet of `GET /harmonizer/datasets/:editionId/harmonized.parquet` or `GET /harmonizer/surveys/:surveyId/harmonized.parquet`, with the same filename (see [Harmonized views](#harmonized-views)). Its errors come back as they are (`404 harmonizer_dataset_not_found`, `400 harmonized_view_empty`, `409 value_type_mismatch`, …).
- The server writes it straight to storage, so it never goes through the browser and the 500 MB upload limit does not apply. The national census edition (383 MB, 15 million rows) takes about 20 seconds. Before, the web app downloaded the view and uploaded it again, which did not work for files that large.
- There is no size limit besides the disk: a resource records its size (`sizeBytes`) as a 64-bit number. Before 2026-11-12 it was 32-bit, and a view over 2,147,483,647 bytes returned `422 resource_too_large`.
- The schema is read and stored as in an upload. The response is the new resource.
- The resource also keeps a copy of the source metadata in `sourceMetadata` (see [Source metadata](#source-metadata)).
- Same roles as an upload: `ADMIN` or `EDITOR` of the dataset's organization. Any logged-in user can read every survey of the harmonizer, so no permission on the survey is needed.

### Source metadata

A resource saved from the harmonizer keeps what was declared about its source in the harmonizer ([Source design](#source-design) and the mapping): `sourceMetadata`. Uploaded files and resources created before 2026-11-13 have `null`.

```json
{
  "version": 1,
  "design": "sample",
  "unit": "person",
  "sourceEditionIds": ["2914422d-…"],
  "missingCodesAreNull": true,
  "columns": [
    { "name": "FOLIO", "type": "BIGINT" },
    { "name": "EDAD", "type": "BIGINT", "missingCodes": ["999"] },
    { "name": "FAC", "type": "BIGINT", "role": "weight" }
  ]
}
```

- `design` and `unit` are those of the edition, and `columns` lists every column of the file in order, with its Parquet `type` (the same `name` and `type` as `columns`).
- `missingCodes` are the column's "not specified" codes in the mapping. `missingCodesAreNull: true` says that those values, and empty cells, are already `NULL` in the file: the codes are kept to describe the source, not to filter it again. `role` is the column's [sample design role](#source-design). Both are left out when the column has none.
- `sourceEditionIds` are the editions the data comes from, only to trace it back (for example, to warn later that a mapping changed). Nothing is computed from them.
- It is a snapshot taken when the resource is created. Changing the edition's design, unit or mapping afterwards does not change it, and reading a resource never looks at the harmonizer.
- A survey view gets metadata only when all its included editions (those that have any of the chosen variables) have the same design and unit, and their expansion factors are the same canonical variable. Otherwise, and when an edition has no design or unit, `sourceMetadata` is `null`. In a survey view, `missingCodes` joins the codes of every edition, and a column has a role only when every edition gives it that role. The origin columns `_dataset`, `_year` and `_row` have only `name` and `type`.
- The shape can grow: per-column properties other than `name` and `type` are optional, `version` names the shape, and readers ignore properties they do not know.
- **In the file.** The same object is in the footer of the resource's Parquet, as JSON under the key `socialdata_metadata` (key-value metadata, written with DuckDB's `KV_METADATA`). Its content is the same as `sourceMetadata`; only the key order can differ, because the database stores JSON as `jsonb`. It is written by the same `COPY` that writes the data, with no extra pass over the file (a Parquet footer cannot be edited without rewriting the whole file), and the server then copies the file to storage byte by byte. Reading it: `SELECT decode(key), decode(value) FROM parquet_kv_metadata('file.parquet')` in DuckDB, or `pyarrow.parquet.read_metadata(path).metadata[b'socialdata_metadata']` in Python. The API reads `sourceMetadata` from the database, never from the file.

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
| `GET` | `.../analyses/:analysisId/vistrace-handoff` | any role | Get a vistrace link. |
| `POST` | `.../analyses/vistrace` | `ADMIN`, `EDITOR`, publish token | Save an analysis built in vistrace. |
| `PUT` | `.../analyses/vistrace/:analysisId` | `ADMIN`, `EDITOR`, publish token | Update an analysis built in vistrace. |

Fields (create and `PATCH` take the same body; `PATCH` replaces everything):

| Field | Rule |
| --- | --- |
| `resourceId` | Required. Must belong to the same dataset. |
| `title` | Required, 2+ characters. |
| `slug` | Required, slug format, unique across all analyses (`409 analysis_slug_taken`). |
| `folder` | Required, free text used to group analyses. |
| `description` | Optional. |
| `visibility` | `PUBLIC` or `PRIVATE`. Defaults to `PRIVATE`. The analysis appears in the [public catalog](#public-catalog) only when it and its dataset are both `PUBLIC`. |
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
- **Origin.** Analyses built here have origin `IBERO`. Analyses saved from vistrace have origin `VISTRACE`.
  - A `VISTRACE` analysis cannot be edited with `PATCH` (`400 analysis_from_vistrace`). It is edited by opening it in vistrace.
  - An `IBERO` analysis cannot be updated through the vistrace `PUT` (`400 analysis_not_from_vistrace`). vistrace must save it as a new analysis.
- **Saving from vistrace.** The body is multipart: the fields above with `sourceResourceId` instead of `resourceId`, `recipe` (the canvas as a JSON string, up to 5 MB) and `file` (the result as Parquet, up to 500 MB). The server does not rerun the canvas; it stores the file it receives. Rules:
  - The recipe must have a canvas (`state.dag` with `nodes` and `edges`) and a `resultNodeId` that exists in it (`400 vistrace_recipe_invalid`).
  - Every table in `recipe.tables` must have a name matching `^[a-zA-Z0-9_]{1,60}$` and point to a resource of the same dataset.
  - Node results and errors are cleared before the recipe is stored.

## Public catalog

These endpoints need no login. The catalog lists **analyses**, not datasets.

An analysis is public when **its status is `DONE`, its own `visibility` is `PUBLIC` and its dataset's visibility is `PUBLIC`**. Making a dataset public does not publish its private analyses.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/public/catalog` | Search. `q` (title, description), `org` (organization slug), `sort` (`recent`, `title-asc`, `title-desc`), `limit` (default 24, max 100), `offset`. |
| `GET` | `/public/catalog/:slug` | One analysis, its result schema, its steps, and the names of the source and joined resources. |
| `GET` | `/public/catalog/:slug/preview` | First rows of the result (`limit`, default and max 500). |
| `GET` | `/public/catalog/:slug/download` | Download the result. |
| `GET` | `/public/catalog/:slug/resources/:resourceId/download` | Download any resource of the analysis' dataset. |
| `GET` | `/public/catalog/:slug/vistrace-handoff` | vistrace link for an anonymous visitor. |
| `GET` | `/public/organizations` | Organizations with at least one public analysis. `q`, `sort` (`name-asc` default, `name-desc`), `limit`, `offset`. |
| `GET` | `/public/organizations/count` | Per organization slug: `sources` (datasets with public analyses) and `charts` (public analyses). |

Response shapes follow CKAN naming (`name` is the slug, `title` the display name, `notes` the description) because vistrace was built against CKAN.

Because the resource download is scoped to the dataset, publishing one analysis also makes every resource of that dataset downloadable.

## vistrace handoff

The handoff opens vistrace with data from this API without sharing the session token.

1. The web app calls a `vistrace-handoff` endpoint and gets `{ url }`.
2. The URL points to `VISTRACE_URL` with a one-time `handoff` code and the download links.
3. vistrace exchanges the code at `POST /api/3/action/duckdb_consume_handoff` with `{ token }`. This endpoint mimics CKAN: it always answers `200`, with `{ success: true, result }` or `{ success: false, error }`.
4. `result` contains the user's email and name, a `download_token`, the dataset context, and the canvas when there is one.

Tokens:

| Token | Lifetime | Use |
| --- | --- | --- |
| Handoff code | 5 minutes, single use | Exchanged once for the payload. Stored in memory: codes are lost on restart and are not shared between server instances. |
| Download token | 10 minutes | Download endpoints. They also accept the normal session token. |
| Publish token | 12 hours | Saving from vistrace. Only valid for the organization and dataset it was issued for (`403 publish_token_scope`). |

Download and publish tokens are checked like a session: the user must still exist and be active, and still needs the required role in the organization.

Public handoffs are issued for an anonymous visitor. They carry no publish token and their links use the public download endpoints.

## Survey harmonizer

The harmonizer lines up variables whose names change between editions of a survey (for example `age` in 2020 and `edad1` in 2021) under one canonical name, so editions can be compared over time.

Concepts:

- **Survey**: groups editions. Its name is unique.
- **Edition** (called `dataset` in the API): one uploaded CSV for one year.
- **Canonical variable**: a common name inside one survey. The same name in two surveys gives two separate variables.
- **Mapping**: "column `edad1` of this edition is canonical `edad`".
- **Dictionary** (called `codebook` in the API): what each column of a file means and what each of its codes means, for example an INEGI census descriptor. It belongs to a survey and can describe many editions.

Every harmonizer endpoint needs a session, and any logged-in user can read and change every survey. Surveys do not belong to organizations. The one exception to the session is `GET /harmonizer/downloads/:token` (see [Direct downloads](#direct-downloads)).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/harmonizer/surveys` | List with editions and mapping progress. Ordered by name. `limit`, `offset`. |
| `POST` | `/harmonizer/surveys` | Create: `{ name, description? }`. |
| `GET` | `/harmonizer/surveys/:surveyId` | One survey. |
| `PATCH` | `/harmonizer/surveys/:surveyId` | Change `name` and/or `description`. |
| `DELETE` | `/harmonizer/surveys/:surveyId` | Delete the survey and everything in it, including the stored files of its editions. Returns `204`. |
| `POST` | `/harmonizer/uploads` | Start an upload of an edition with tus (CSV, `.csv.gz` or DBF). See [Upload](#upload). |
| `HEAD`, `PATCH`, `DELETE` | `/harmonizer/uploads/:importId` | Continue (tus `PATCH`), check (`HEAD`) or cancel (`DELETE`) an upload. |
| `GET` | `/harmonizer/imports/:importId` | Status of an upload and of its import. See [Imports](#imports). |
| `POST` | `/harmonizer/upload` | Upload an edition in one request (multipart), as CSV or DBF. Up to 200 MB, read in memory. The web app uses tus instead. |
| `PATCH` | `/harmonizer/datasets/:datasetId` | Change the source `design` and/or `unit` of an edition. See [Source design](#source-design). |
| `DELETE` | `/harmonizer/datasets/:datasetId` | Delete one edition, its mapping and its stored file. Returns `204`. |
| `GET` | `/harmonizer/datasets/:datasetId/mapping` | Columns of an edition with saved or suggested mappings. |
| `PUT` | `/harmonizer/datasets/:datasetId/mapping` | Save the mapping of an edition. |
| `GET` | `/harmonizer/datasets/:datasetId/mapping/saved` | The saved mapping of an edition, without reading its data (to copy it to another edition). |
| `PUT` | `/harmonizer/datasets/:datasetId/codebook` | Attach a dictionary to an edition, or detach it. See [Dictionaries](#dictionaries). |
| `GET` | `/harmonizer/surveys/:surveyId/codebooks` | Dictionaries of a survey. |
| `POST` | `/harmonizer/surveys/:surveyId/codebooks` | Upload a dictionary (multipart: `file`, `name`). |
| `GET` | `/harmonizer/codebooks/:codebookId` | One dictionary with all its variables. |
| `DELETE` | `/harmonizer/codebooks/:codebookId` | Delete a dictionary. Returns `204`. |
| `GET` | `/harmonizer/datasets/:datasetId/harmonized` | Harmonized view of one edition, one page at a time (`limit`, `offset`). |
| `GET` | `/harmonizer/datasets/:datasetId/harmonized.csv` | Same, as CSV. Also `.parquet`. |
| `GET` | `/harmonizer/datasets/:datasetId/original.csv` | The uploaded file, rebuilt from storage with every column. See [Original file](#original-file). |
| `POST` | `/harmonizer/datasets/:datasetId/harmonized.csv/download` | Prepare the edition's CSV for a direct download. Also `.parquet`, and `original.csv/download`. See [Direct downloads](#direct-downloads). |
| `GET` | `/harmonizer/surveys/:surveyId/variables` | Canonical variables of the survey and where each one is mapped. |
| `PATCH` | `/harmonizer/surveys/:surveyId/variables/:variableId` | Rename a canonical variable: `{ name }`. |
| `DELETE` | `/harmonizer/surveys/:surveyId/variables/:variableId` | Delete a canonical variable that no edition maps. Returns `204`. |
| `GET` | `/harmonizer/surveys/:surveyId/variables/:variableId/comparison` | The codes of a variable in each edition, their differences and a recoding proposal. See [Codes between editions](#codes-between-editions). |
| `POST` | `/harmonizer/surveys/:surveyId/variables/:variableId/review` | Mark the current differences as reviewed. |
| `DELETE` | `/harmonizer/surveys/:surveyId/variables/:variableId/review` | Remove the review. Returns `204`. |
| `PUT` | `/harmonizer/surveys/:surveyId/variables/:variableId/recoding` | Save the catalog of the variable and the recoding of its editions. |
| `GET` | `/harmonizer/surveys/:surveyId/catalog.csv` | Catalog of categories of every variable that has one. |
| `GET` | `/harmonizer/surveys/:surveyId/harmonized` | Harmonized view of all editions, one page at a time (`limit`, `offset`). Optional `variables`. |
| `GET` | `/harmonizer/surveys/:surveyId/harmonized.csv` | Same, as CSV. Also `.parquet`. |
| `POST` | `/harmonizer/surveys/:surveyId/harmonized.csv/download` | Prepare the survey's CSV for a direct download. Also `.parquet`. Optional `variables`. |
| `GET` | `/harmonizer/downloads/:token` | A prepared download. No session. |

### Surveys

- The name is trimmed and cannot be empty (`400 survey_name_required`).
- Names are unique. Creating or renaming to a taken name returns `409 survey_name_taken`.
- Sending an empty `description` in `PATCH` clears it.
- Renaming a survey does not change its editions, canonical variables or mappings.
- Deleting a survey also deletes its editions, their stored Parquet files, their mappings and its canonical variables. A missing survey returns `404 survey_not_found`.
- If the file of any of its editions cannot be removed, nothing is deleted and the survey returns `409 harmonizer_file_in_use`, naming that edition. See [Deleting an edition](#deleting-an-edition).

### Deleting an edition

- `DELETE /harmonizer/datasets/:datasetId` deletes the edition, its mappings and its stored Parquet file. The survey and its other editions are not changed. A missing edition returns `404 harmonizer_dataset_not_found`.
- The survey's canonical variables are kept, including their confirmed `dataType`, so a corrected file can be uploaded again and mapped to the same names. A canonical that no edition maps any more stops appearing in the survey view (`available` only lists mapped canonicals).
- Once deleted, the edition's name is free again, so the corrected file can be uploaded with the same name.
- The stored file is moved aside (renamed to `<datasetId>.parquet.deleting`) before the edition is deleted from the database, and removed after. On Windows a file that another program has open (a viewer, a backup or sync tool) cannot be renamed. In that case nothing is deleted: the edition stays as it was and the request returns `409 harmonizer_file_in_use` with a Spanish message asking to close the file and try again. Before this, the edition was deleted, the request returned `204`, and the file stayed on disk with nothing pointing to it.

### Upload

There are two ways to upload an edition. Both read the file with the same rules and answer with the same error codes, described in this section.

- **tus** (`POST /harmonizer/uploads`, used by the web app): a resumable upload protocol ([tus 1.0](https://tus.io/protocols/resumable-upload)). The file arrives in chunks (the web app sends 50 MB per request) and a chunk that fails is sent again, so files of several gigabytes can be uploaded. The server writes the file to disk as it arrives and never holds it in memory. When it is complete, the worker process reads it and creates the edition in the background; the client follows it with `GET /harmonizer/imports/:importId` (see [Imports](#imports)). Up to `UPLOAD_MAX_BYTES` (10 GiB by default).
- **One request** (`POST /harmonizer/upload`, multipart): the file is read in memory and the response is the new edition. Up to 200 MB. Kept for scripts; large files can take the server down.

Fields: `file`, `name` (edition name, required), `year` (1900–2100), `surveyId`, `newSurvey`, `organizationId` (with `__new__`), `encoding` (DBF only, see [DBF files](#dbf-files)), and `design` and `unit` (both required, see [Source design](#source-design)).

With tus, the fields go in the `Upload-Metadata` header of the `POST`, with the same names, except that the edition name is `editionName` (tus clients such as Uppy use `name` for the file name) and the file name is `filename`. Every request needs the session token (`Authorization: Bearer …`). The `POST` checks, before any byte is sent and in this order, everything that does not need the file's content, with the same codes as the one-request upload:

1. The fields (`400 validation_error`, with `details` naming `name`, `year`, …, or `filename`), and the file size (`400 upload_length_required` if the client does not send it). Then the source design and unit: `400 source_info_required` if either is missing (see [Source design](#source-design)).
2. Permissions: `400 survey_organization_required`, `404 organization_not_found`, `403 survey_org_role_required`, `404 survey_not_found`, `403 survey_not_editable`.
3. Size: `413 upload_too_large` (over `UPLOAD_MAX_BYTES`) or `413 dbf_too_large` (a `.dbf` over `DBF_MAX_BYTES`), with `params: { maxBytes, size }`.
4. Names: `400 new_survey_name_required`, `409 survey_name_taken`, `409 dataset_name_taken`.

Errors are JSON with the usual shape (`{ statusCode, code, message, params? }`). The `Location` of the new upload is `/harmonizer/uploads/<importId>`: its last part is the import id. Only the user who started an upload (or the sysadmin) can continue, check or cancel it (`404 upload_not_found` for anyone else). After the last byte, `PATCH` and `DELETE` answer `409 upload_finished`.

Errors that need the file's content (encoding, CSV structure, DBF problems, empty files) cannot be known before it arrives, so with tus they are reported by the import, with the same body.

File formats, by name: `.dbf` is a DBF table, `.gz` a gzip-compressed CSV (`.csv.gz`, tus only; a broken one fails with `400 gzip_invalid`, and one whose CSV is larger than `UPLOAD_MAX_UNCOMPRESSED_BYTES` once decompressed fails with `413 gzip_too_large`, `params: { maxBytes }`), anything else a CSV.

- `surveyId` is an existing survey ID, or `__new__` to create a survey named `newSurvey` in the same request.
  - With `__new__`, `newSurvey` is required (`400 new_survey_name_required`) and must not be taken (`409 survey_name_taken`).
  - An unknown ID returns `404 survey_not_found`.
- Maximum size: 200 MB. A file whose name ends in `.dbf` (any case) is read as a DBF table, see [DBF files](#dbf-files). Any other file must parse as CSV (`400 csv_invalid`); its extension is not checked. The rules below about quotes, UTF-8, blank lines and the header row apply to CSV.
- A quote inside a value that is not itself quoted, such as `{"clave":1}` or `5" pantalla`, is kept as written, like pandas, Polars and Python's `csv` module do (report H-07). Quoted values follow the usual rules: they may contain commas and line breaks, and `""` is a literal quote.
- These files are still rejected with `400 csv_invalid`: a quote that opens a value and is never closed, and a row with more or fewer fields than the header. `params` gives `problem` (`quote_not_closed`, `inconsistent_columns` with `rowColumns` and `headerColumns`, or `unreadable`) and the `line`; the whole file is rejected and nothing is written.
- The file must be valid UTF-8 (a BOM is allowed). Any other encoding, such as Latin-1, returns `400 csv_not_utf8` with the line of the first invalid byte, instead of storing accented characters as `�`.
- The file must have a header and at least one data row. A file with no header (for example 0 bytes or only blank lines) returns `400 csv_empty`; a file with a header but no data rows returns `400 csv_no_rows` (report H-08).
- The response is `{ datasetId, dataset, renamedColumns, source }`. `source` says how the file was read, so the client can tell the user; it is not stored. It is `{ format: "csv" }`, or for a DBF `{ format: "dbf", encoding, encodingSource, deletedRecords }`. `dataset` includes `rowCount`, the number of data rows read (the header and skipped blank lines are not counted), so the client can check that nothing was dropped (report H-09). The same `dataset` object, with `rowCount`, is returned by `GET .../mapping` and the edition's harmonized view. It also includes `columnCount`, the number of columns in the uploaded file whether mapped or not, because the harmonized view only shows mapped columns (report H-18).
- `dataset` also includes `design` and `unit` (see [Source design](#source-design)), here and in every response that returns it.
- The file is checked before anything is written, so a rejected upload with `__new__` does not create the survey.
- The first row is the header. A leading BOM is removed, blank lines are skipped, and values are kept exactly as written: no trimming and no type conversion. Every value is stored as text, and empty cells are `""`.
- Headers are trimmed (leading and trailing spaces removed) before anything else. Spaces inside a name are kept.
- Repeated headers, compared after trimming, are renamed by appending `.1`, `.2`, and so on (`edad`, `edad.1`). `EDAD ` and `EDAD` become `EDAD` and `EDAD.1`. A suffix that would clash with another header in the file is skipped: `EDAD, EDAD, EDAD.1` becomes `EDAD, EDAD.2, EDAD.1`. An empty header (or one with only spaces) is named `columna_N`, where `N` is its position starting at 1 (`ID,,EDAD` becomes `ID, columna_2, EDAD`); if the file already has that name, the automatic one gets a suffix like any repeated header. The upload response lists each rename in `renamedColumns` as `{ position, original, renamed }` (`position` starts at 1; `original` is `""` for an empty header; `[]` when nothing was renamed), so the client can warn the user (report H-10). Editions uploaded before empty headers were named keep their empty header.
- The header order is stored and used for column order in the harmonized view.
- All columns are stored, including those that are never mapped.
- The edition name, after trimming, must be unique within its survey, because it is the `_dataset` of the survey view. A repeated name returns `409 dataset_name_taken` and nothing is written. Names are compared exactly (case and accents matter).
- Uploading never changes other editions. Uploading the same file twice under two names creates two editions.

### Source design

Every upload declares two facts about its source, which travel with the edition so analyses can use them later:

- `design`: `census` (every unit was enumerated) or `sample` (each record stands for several units and the source has an expansion factor).
- `unit`: the unit of analysis, what each record is: `person`, `dwelling` or `household`.

Rules:

- Both are required in both upload ways. An upload without one or both returns `400 source_info_required`, with `params: { missing }` listing `design`, `unit` or both, and a `message` naming each one (for example "Missing the source design (census or sample) and the unit of analysis (person, dwelling or household)."). An empty field counts as missing. Any other value returns `400 validation_error` (`design must be one of: census, sample.`). Both checks run with the other field checks, before permissions and before any byte of a tus upload.
- `PATCH /harmonizer/datasets/:datasetId` with `{ design?, unit? }` changes them (same permission as saving the mapping). Switching to `census` removes every role of the edition's mapping. Switching to `sample` keeps the mapping as it is; it cannot be saved again until a column is marked as `weight`. It returns the edition's `dataset` object.
- Editions uploaded before these fields existed have `design: null` and `unit: null`. Their mapping saves as before, without roles, and `PATCH` sets them.

In a `sample` edition the mapping can give a column a sample design role (`role` in `PUT .../mapping`):

| `role` | Meaning |
| --- | --- |
| `weight` | Expansion factor: how many units of the population the record stands for. Required in sample editions. |
| `stratum` | Stratum of the sample design. Optional. |
| `psu` | Primary sampling unit (UPM). Optional. |

- Saving the mapping of a `sample` edition with no column marked `weight` returns `400 sample_weight_required`.
- Each role can be in at most one column (`400 source_role_repeated`, `params: { role, columns }`). A column has at most one role.
- A role needs a mapped column, because unmapped columns are not in the harmonized view (`400 source_role_unmapped`, `params: { column, role }`).
- `census` editions, and editions without a design, take no roles (`400 source_role_not_allowed`, `params: { column, role, design }`).
- These checks run before anything is saved. The role belongs to the mapping: unmapping the column discards it.

### Imports

Each tus upload has an import, with the same id, that records what happened to it. `GET /harmonizer/imports/:importId` returns it to the user who started it (or the sysadmin); anyone else gets `404 harmonizer_import_not_found`.

`status` is one of:

| Status | Meaning |
| --- | --- |
| `UPLOADING` | Bytes are still arriving. |
| `PENDING` | The file is complete and waits for the worker. |
| `PROCESSING` | The worker is reading it. `phase` is `checking` (the whole file must be UTF-8), `reading` (rows; `rowsRead` grows every few seconds) or `saving`. |
| `COMPLETED` | The edition exists. `result` is what `POST /harmonizer/upload` answers: `{ datasetId, dataset, renamedColumns, source }`. |
| `FAILED` | `error` is the body `POST /harmonizer/upload` would have answered, for example `{ statusCode: 400, code: "csv_not_utf8", message, params: { line: 7 } }`. |

The response also has `fileName`, `fileSize`, `format` (`csv`, `csv_gz` or `dbf`), `name`, `year`, `surveyId`, `newSurveyName`, `datasetId`, `createdAt`, `uploadedAt`, `startedAt` and `finishedAt`.

How the worker imports a CSV (see [Background jobs](#background-jobs)):

1. It reads the whole file once to check that it is UTF-8 (`csv_not_utf8` with the line of the first bad byte), before parsing anything, as the one-request upload does. A `.csv.gz` is decompressed as it is read and stops with `413 gzip_too_large` as soon as it passes `UPLOAD_MAX_UNCOMPRESSED_BYTES`, so a small file that decompresses to a huge one never reaches the Parquet. In the same pass it keeps the original, gzip-compressed (see [Original file](#original-file)); this is always done, for every CSV uploaded with tus.
2. It reads it again, row by row, with the same parser and options as the one-request upload, and writes the edition's Parquet through a DuckDB database file in `DUCKDB_TEMP_DIR`, so a file larger than `DUCKDB_MEMORY_LIMIT` spills to disk. Values, quotes, blank lines, headers (trimmed, repeated, empty) and every CSV error are the same as in the one-request upload.
3. It checks the names again (another upload may have taken them meanwhile) and creates the survey (with `__new__`) and the edition in one transaction, so a failure leaves neither.
4. It computes the value profiles of every column and the suggested type of each one (as `GET .../mapping` first asks for it, see [Variable types](#variable-types)). If that fails, they are computed later when needed; the import does not fail for it.

A DBF is read whole in memory, as in the one-request upload. When the import ends, either way, the uploaded file is deleted from `UPLOAD_DIR`; a rejected file has to be fixed and uploaded again.

Measured on a Mac (24 GB) with the national 2020 census (`Personas00.CSV`, 3.1 GB, 15,015,683 rows, 91 columns): the upload added 25 MB to the API's memory; the worker took about 4 min 35 s with `DUCKDB_MEMORY_LIMIT=4GB` and peaked at 4.1 GB.

Recovery:

- If the job cannot be queued when the upload ends (Redis down), or a queued job is lost, the API queues again, every minute, imports that have been `PENDING` or `PROCESSING` for over a minute without a waiting or running job.
- An import that the worker started 3 times without finishing (the worker crashed or was killed, for example for memory) fails with `500 import_interrupted`.
- An upload cancelled with `DELETE` fails with `upload_cancelled`. One not finished within `UPLOAD_EXPIRATION_HOURS` is deleted (checked every hour) and fails with `410 upload_expired`.
- An unexpected error fails the import with `500 internal_error`; the details are in the worker's log.

### DBF files

dBase and FoxPro tables (`.dbf`), as INEGI distributes its census microdata, are uploaded through the same endpoint. After reading, they follow the same rules as a CSV: every value is stored as text, headers are trimmed and repeated names renamed, and the rest of the harmonizer cannot tell the two formats apart.

- Columns of type text (`C`), number (`N`, `F`), date (`D`, kept as written, `YYYYMMDD`) and logical (`L`) are read. The padding of the fixed-width format is removed: trailing spaces in text, both sides in the other types. Leading spaces in text are data and are kept. Values are not converted (`01` stays `01`).
- A memo column (`M`, `G`, `P`, `B`) keeps its content in a separate `.dbt` or `.fpt` file that is not uploaded, and any other type cannot be read: either returns `400 dbf_field_unsupported`, naming the column. Visual FoxPro's internal `_NullFlags` column is skipped.
- Records marked as deleted (`*`) are not loaded. `rowCount` counts only the other ones, and the upload response gives the deleted ones in `source.deletedRecords`.
- A file that is not a DBF, has no columns, or is truncated (fewer records than its header announces) returns `400 dbf_invalid`. A DBF with no records left returns `400 dbf_no_rows`.
- Encoding. The optional `encoding` field is `auto` (the default), `windows-1252`, `cp850`, `cp437` or `utf-8`; anything else is a `validation_error`. It is ignored for CSV, which is always UTF-8.
  - With `auto`, the encoding is the one the header declares (byte 29, the language driver: `0x01` CP437, `0x02` CP850, `0x03`/`0x57`/`0x58`/`0x59` Windows-1252). If the header does not declare one, it is deduced from the text: UTF-8 when every non-ASCII column name and text value is valid UTF-8, otherwise whichever of CP850 and Windows-1252 yields more Spanish letters (á, ñ, ¿…), Windows-1252 on a tie.
  - A chosen encoding is used even if the header declares another one. `utf-8` is strict: an invalid byte returns `400 dbf_not_utf8` with the record and column, instead of storing `�`.
  - The response gives the encoding used in `source.encoding` and where it came from in `source.encodingSource` (`user`, `header` or `content`). If the text looks wrong, delete the edition and upload it again with another encoding.
- [Original file](#original-file) returns a DBF edition as CSV.

### Mapping

`GET .../mapping` returns each column with `selectedCanonicalId`, `suggested`, `suggestionSource`, `missingCodes` (the saved missing-value codes; `[]` for unsaved columns, suggestions never fill it), `role` (the saved [sample design role](#source-design) or `null`) and `inferredType` (see [Variable types](#variable-types)). `canonicalVariables` lists the survey's canonicals as `{ id, name, dataType }`, where `dataType` is the confirmed type or `null`. For each column, the first of these that applies is used:

1. **Saved**: the mapping already saved for this edition. No suggestion is shown.
2. **History** (`suggestionSource: "history"`): a column with exactly the same name was mapped in another edition of the same survey.
3. **Name** (`suggestionSource: "name"`): a canonical variable matches the column name. Names are compared after removing accents, lowercasing and turning any run of other characters into `_`. An exact match wins. Otherwise the canonical name must appear as a whole part of the column, optionally followed by digits: `edad` matches `edad1` and `edad_jefe`, but not `edades`. Ties go to the longer canonical name.
4. **Description** (`suggestionSource: "description"`): the edition has a dictionary, and the column's description in it equals the description of exactly one canonical variable (after removing accents, lowercasing and collapsing punctuation and spaces). This finds columns renamed between editions, such as `PARENT` (2010) and `PARENTESCO` (2020), both "Parentesco".
5. Otherwise the column is unmapped.

History and name suggestions never reuse a canonical variable that another column of the same edition already has (saved, or suggested to an earlier column in the header). The column is then left unmapped.

Each column also has `values`, a summary of its values in this edition so they can be seen before mapping: `{ top, distinct, distinctCapped, empty }`.

- It comes from the column's stored **profile** (see [Codes between editions](#codes-between-editions)): its 200 most frequent distinct values over the whole file, with their counts, and its empty cells. The rows are not read again.
- `top` has up to 5 `{ value, count }`, most frequent first; on a tie, in alphabetical order.
- Values are trimmed and counted as they are in the file. Trimming, here and in the rest of the harmonizer (missing codes, recoding, views, type checks), removes what JavaScript's `trim()` removes: spaces, tabs, line breaks, no-break spaces and the BOM character (U+FEFF). So `1`, ` 1` and `\ufeff1` are the same value, counted together. Missing-value codes are not removed, so a `9` or `99` shows up before it is marked as missing. Empty or blank cells are not values: they are counted in `empty`.
- `distinct` is the number of different values, counted up to 200. When a column has more, `distinct` is `200` and `distinctCapped` is `true`.

The response also has:

- `codebook`: the dictionary attached to the edition, `{ id, name, table, matchedColumns }`, or `null`.
- `codebooks`: the survey's dictionaries, `[{ id, name, tables }]`, so the client can offer them.
- `otherEditions`: the survey's other editions, `[{ id, name, year, mappedColumns }]`, so the client can copy one's saved mapping (see `GET .../mapping/saved` below).
- `canonicalVariables[].description`.
- For each column, `codebook`: what the edition's dictionary says about it, or `null` when the edition has no dictionary or the dictionary does not have that column. It is `{ name, label, question, section, declaredType, categories, missingCodes, suggestedType }`. `missingCodes` are the dictionary's "No especificado" codes written as they appear in the data (a code `99` matches a value `099`); a code that does not appear in the data is given as the dictionary writes it. `suggestedType` is `text` when the dictionary says text ("Caracter") or when the variable has two or more coded categories, so codes such as `01` keep their zeros; for a numeric declared type it is `integer` or `decimal` when every value fits, after removing `missingCodes`, and `text` otherwise; with no declared type it is the inferred type.

Suggestions are preselected in the response but are not saved until the client sends `PUT`.

`GET .../mapping/saved` returns `{ dataset, columns }`, where each column is `{ column, canonicalId, canonicalName, missingCodes, role }`, in header order. It does not read the edition's file.

`PUT .../mapping` takes `{ columns: [{ column, choice, newName?, dataType?, missingCodes?, role? }] }` (`role`: see [Source design](#source-design)):

| `choice` | Effect |
| --- | --- |
| `cv:<canonicalId>` | Map to that canonical variable. It must belong to the same survey (`400 canonical_variable_not_found`). |
| `__new__` | Map to the canonical named `newName`. It is created if it does not exist in the survey; the new name must follow the [naming rules](#canonical-variables). A `newName` identical to an existing canonical reuses it. An empty `newName` leaves the column unmapped. The new canonical's description is `newDescription` or, when it is not sent, the column's description in the edition's dictionary. |
| anything else | Leave the column unmapped. |

- `PUT` replaces the whole mapping of the edition. Columns that are left out of the request become unmapped.
- Entries for columns that are not in the edition are ignored.
- The save runs in one transaction. Existing mappings and canonicals are read once and only the mappings that change are written, so saving a 500-column file where 4 columns changed costs about the same as a small file (report H-15 / SDI-63).
- A canonical variable without a description takes the description of the column that maps it in the edition's dictionary.
- A column that keeps its canonical variable keeps its [recoding](#recoding). A column mapped to another canonical loses it, because the recoding belongs to the old variable.
- Canonical names are trimmed. A new name that breaks the [naming rules](#canonical-variables) returns `400 canonical_variable_name_invalid`; one that differs only in case from an existing canonical, or from another new name in the same request, returns `409 canonical_variable_name_taken`. The `message` names the column. Both checks run before anything is saved.
- `missingCodes` lists the values that mean "not specified" in that column of that edition (for example `["9", "99"]`). Codes are trimmed, and empty and repeated codes are dropped. They belong to the mapping, so each edition keeps its own codes, and unmapping the column discards them.
- Unmapping every column that used a canonical variable does not delete it. See [Canonical variables](#canonical-variables) to rename or delete one.
- Two columns of the same edition cannot use the same canonical variable, because the harmonized view has one column per canonical. Such a request returns `409 canonical_variable_collision`, the `message` lists the columns involved, and nothing is saved (including canonicals that `__new__` would have created). Two `__new__` entries with the same `newName`, or a `newName` equal to an existing canonical that another column uses, also collide.

### Canonical variables

A canonical name is a column of the harmonized view and of the exported Parquet, so it must work as a plain SQL identifier in DuckDB:

- 2 to 64 characters.
- Starts with a letter without accent (`A`–`Z`, `a`–`z`).
- Then only letters without accent, digits and `_`. No spaces, commas, hyphens or other symbols.
- Names are unique per survey ignoring case, because DuckDB treats `edad` and `EDAD` as the same column. The stored name keeps its case.
- Since names start with a letter, they can never be `_dataset`, `_year` or `_row`, the origin columns of the survey view.

The rules apply when a canonical is created (`__new__` in `PUT .../mapping`) and when it is renamed. Names created before the rules are kept and still work; `GET .../variables` marks them with `nameValid: false` so they can be renamed.

`GET /harmonizer/surveys/:surveyId/variables` returns `{ survey: { id, name }, items }`. Each item is `{ id, name, dataType, nameValid, usages }`, ordered by name, and `usages` lists `{ datasetId, datasetName, year, column }` for each edition that maps it (`[]` when none does).

`PATCH .../variables/:variableId` takes `{ name }`:

- The name is trimmed and checked against the rules (`400 canonical_variable_name_invalid`).
- Another canonical of the survey with the same name ignoring case returns `409 canonical_variable_name_taken`. Changing only the case of the variable's own name is allowed.
- Mappings point to the canonical's ID, so every edition shows the new name right away. Files already exported or saved as datasets keep the old name.
- Returns `{ id, name, dataType }`.

`DELETE .../variables/:variableId` deletes a canonical that no edition maps and returns `204`. If any edition maps it, it returns `409 canonical_variable_in_use`, the `message` lists the editions and columns, and nothing is deleted.

For these three endpoints, an unknown survey returns `404 survey_not_found` and a variable that does not belong to the survey returns `404 canonical_variable_not_found`.

### Variable types

Each canonical variable has one type, used for its column in the Parquet export: `text`, `integer` or `decimal`. CSV is always text.

- **Inferred.** `inferredType` comes from all the column's values in this edition, after the saved missing codes turn into `null`. DuckDB checks the distinct values over the stored Parquet, so the rows are not loaded into the server; the checks follow exactly the rules below (`column-checks.spec.ts` compares them with the JavaScript rules). Since the data never changes, each result is stored in the database (`harmonizer_column_checks`, keyed by the check's query) and reused: changing the saved codes of a column, or attaching a dictionary, only computes the new checks. The worker computes them for every column right after an import; for older editions the first `GET .../mapping` computes them, which on the national census (15 million rows) takes about 5 seconds. It is `integer` when every value is a whole number (sign and surrounding spaces allowed), `decimal` when every value is a number and at least one is not whole (`2.5`, `.5`, `1e3`), and `text` otherwise. A value with a leading zero (`01`, a state code) makes the column `text` so the zero is kept, and so does a number too large for a double (`1e309`). So does a whole number of more than 15 digits, which is usually an identifier. A column with no values is `text`.
- **Confirmed.** `dataType` on a `PUT` entry sets the type of the column's canonical variable, which confirms it. Leaving it out keeps the current type. The type belongs to the variable, so it applies to every edition that maps it. A canonical created before this change, or never sent a `dataType`, has `dataType: null` (not confirmed).
- **Validation.** For `integer` (a whole number that fits in 64 bits; leading zeros allowed) or `decimal` (a finite number), every non-missing value of the column must fit, using the `missingCodes` of the same request and the column's saved recoding. Otherwise the request returns `400 value_type_mismatch`, its `params` has `source` (`column`, `other_edition`, `confirmed_type` or `recoding`), `expectedType` and up to 5 offending `values`, and nothing is saved. When the request changes the type of an existing canonical, the other editions that map it are checked too, with their own saved codes and recoding. Validation asks DuckDB, over the stored files and before the save transaction starts, for the offending values of only the columns it checks (in order of first appearance); the rows are not loaded into the server. A column already saved with the same canonical, the same codes and the canonical's confirmed type is not read again.

### Harmonized views

Views are computed on every request from the edition's stored Parquet (see [File storage](#file-storage)) and its mappings. Nothing is materialized.

Paging:

- The two JSON views return one page of rows. `limit` is the page size: 100 by default, at most 500 (the web app offers 50, 100 and 500). `offset` is the number of rows to skip, 0 by default. Like the survey list, invalid values are not rejected: `limit` is clamped to 1–500 and a negative or non-numeric `offset` becomes 0.
- The response adds `total` (rows of the whole view), `limit` and `offset`. An `offset` past the end returns no rows and the same `total`.
- Only the rows of the page and the mapped columns are read from the stored Parquet (DuckDB `LIMIT`/`OFFSET`, which keeps file order). `total` comes from the stored `rowCount` of each edition, so nothing is counted.
- In the survey view, editions are stacked in the same order as the export, so a page can end in one edition and continue in the next. Row `n` of the view is the same row in every page size and in the CSV export.
- Exports (`.csv`, `.parquet`) are not paged: they contain the whole view. They do not load it into the server's memory either (see Exports below).

Edition view:

- Columns are the canonical names of the mapped columns, in header order.
- An edition with no mappings has no columns and no rows.
- **Missing values.** A value is `null` when the cell is empty, contains only spaces, or, once trimmed, equals one of the column's `missingCodes`. Every other value, `0` included, is returned exactly as stored. The stored rows are never changed, so editing the codes changes the view right away.
- **Recoding.** After missing values, a value whose trimmed text is in the column's recoding is replaced by its common code (see [Recoding](#recoding)). Values that are not in the recoding are returned as stored. Exports apply it too, before the Parquet types.

Survey view:

- `variables` picks the canonical variables to include. Repeat it for several (`?variables=edad&variables=sexo`). Commas are not separators, because a canonical name can contain one (report H-13). Without it, the view includes every canonical variable that has at least one mapping.
- Columns always come in alphabetical order, whatever order `variables` uses, so their positions do not change between downloads (report H-14). Names that are not mapped canonical variables of the survey are ignored; if none is valid, the view is empty.
- Editions are stacked by year, then by upload time.
- Every row gets `_dataset` (edition name), `_year` and `_row`. `_row` is the record number in the uploaded file, starting at 1 with the first row after the header. It counts records, not lines, so a value with a line break does not shift it.
- `_dataset` + `_row` identifies every row, even when the file has no ID column or repeats IDs across editions. Columns from the file, such as a person ID, are usually repeated across editions, so joining on them alone duplicates rows.
- A variable that an edition does not have is missing from that edition's rows.
- Missing values keep the codes of their own edition: a `9` is `null` only in editions where `9` is a missing code for that column.
- Rows that have none of the selected variables are dropped.
- The JSON response adds `codeWarnings`: the selected variables whose codes differ between editions and that nobody has reviewed (status `warning` in [Codes between editions](#codes-between-editions)), as `[{ id, name, issueCount }]` in alphabetical order.

Exports:

- Formats: `csv` and `parquet`. Any other extension returns `404 export_format_not_supported`.
- The filename is `harmonized_<edition>_<year>` or `harmonized_<survey>`, with accents and symbols removed.
- The survey export puts `_dataset`, `_year` and `_row` first. The edition export does not include them.
- CSV is UTF-8 with a BOM, so Excel opens it correctly. Missing values are empty.
- In CSV, values and headers that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'`, so spreadsheets do not run them as formulas (report H-12). Plain numbers such as `-5` or `+3.2` are left as they are. Parquet is not changed.
- Parquet columns take the canonical variable's confirmed type, or the type inferred from the exported values when it is not confirmed (the same rules as `inferredType`, applied to all exported editions together): `text` → `VARCHAR`, `integer` → `BIGINT`, `decimal` → `DOUBLE`. Numbers are converted from the trimmed text, trimmed as everywhere in the harmonizer (see [Mapping](#mapping)), so a value such as `\ufeff1` or `1` followed by a tab, which the type checks accept as an integer, becomes `1` (before 2026-11-12 only spaces were trimmed here and the export failed with `400 parquet_write_failed`). `_dataset` is `VARCHAR`, and `_year` and `_row` are `BIGINT`. Missing values are `NULL`, so they are distinct from any value. This lets analyses sum, average, multiply and compare these columns (before, every column was text and `SUM` failed).
- If a confirmed numeric variable has a value that does not fit (possible only for an edition saved without `dataType`), the Parquet export returns `409 value_type_mismatch` with the variable and the offending values.
- Exporting an edition with no mappings as Parquet returns `400 harmonized_view_empty`.
- The Parquet carries its [source metadata](#source-metadata) in its footer, as JSON under the key `socialdata_metadata` (DuckDB `KV_METADATA`), so the file describes itself outside the platform too. Views without metadata (an edition without design or unit, or a survey whose editions differ) have no such key.
- How the file is made: DuckDB reads the editions' stored Parquet and applies the missing codes, the recoding and the types, so the rows are never loaded into the server whole (`harmonized-export.ts`). The Parquet is written by DuckDB, one edition after another. For the CSV, DuckDB also writes the rows: each line is built in SQL with the quoting of the CSV writer the server used before (`csv-stringify`: a value is quoted when it has a `"`, a `,` or a line feed, and its quotes are doubled) and with the formula neutralization; the BOM and the header line are written by that same CSV writer. A failure there returns `400 csv_write_failed`. Both are written to a temporary file first, so any error (`409 value_type_mismatch`, `404 harmonizer_dataset_file_missing`) comes back as a normal error response before anything is sent; then the file is sent and deleted, also when the client disconnects. The types are checked with the same stored column checks as the mapping (see [Variable types](#variable-types)). On the national census (15 million rows, 91 columns), the edition's Parquet takes about 20 seconds and its CSV (3.3 GB) about 15 seconds.

### Dictionaries

A dictionary describes the columns of a file: for each variable, its description, question, section, declared type, valid range and length, and its categories (code and label). With it, the mapping page shows what each column and code means, fills the "No especificado" codes and suggests types, and the [comparison between editions](#codes-between-editions) can tell when a code changed meaning.

Two formats are read, chosen by the file extension (any other returns `400 codebook_format_unsupported`):

- **INEGI descriptor** (`.xls`, `.xlsx`), as INEGI publishes it for the census ("Descriptor_cpv2010.xls", "Descriptor_cpv2020.xlsx"). Each sheet that has a "Mnemónico" header is a table (VIVIENDAS, PERSONAS, MIGRANTES); other sheets ("Modelo de datos") are skipped. The columns are found by their header ("Descripción", "Mnemónico", "Pregunta y categoría", "Tipo", "Rango válido", "Longitud"), so the 2010 layout (no "Tipo") and the 2020 one both work. A row with a mnemonic starts a variable; the rows below it with a text and a code are its categories; a row with only a title is a section (IDENTIFICACIÓN GEOGRÁFICA…); rows with only a number (sums of "Longitud") are skipped. Codes Excel stores as numbers are read as text without `.0` (`99`). A repeated mnemonic in a sheet keeps the first one. "Caracter" is `text` and "Numérico" is `integer`.
- **CSV template** (`.csv`, UTF-8, `400 csv_not_utf8` otherwise) for other surveys, or for descriptors only published as PDF (census 1990 and 2000). Columns, matched without accents or case: `tabla`, `variable` (required), `descripcion`, `pregunta`, `seccion`, `tipo` (`texto`, `entero` or `decimal`), `codigo`, `etiqueta`, `faltante`. Each row is a variable or one of its categories: the first row of a variable gives its metadata, and each row with `codigo` or `etiqueta` adds a category. `faltante` = `sí` marks the category as "No especificado". `tabla` separates variables of different files; without it every variable is in table `""`.

Each category has a `kind`: `value` (a code), `missing` (its label starts with "No especificado"; or `faltante` = `sí`), `blank` ("Blanco por pase", code `b` or `Nulo`: the question did not apply; in the data it is an empty cell, which is already `null`, so its code is `""`), `range` (a code with `..`, such as `1..130` = "Años cumplidos") or `catalog` (the codes come from an external catalog that the descriptor does not include, such as `Tc_Entidad_2010`).

`POST /harmonizer/surveys/:surveyId/codebooks` takes `file` (at most 20 MB) and `name`:

- `name` is trimmed and required (`400 codebook_name_required`) and unique per survey (`409 codebook_name_taken`). A missing file returns `400 file_required`.
- A file that cannot be read returns `400 codebook_invalid` with `params.problem`: `unreadable`, `no_dictionary` (no sheet has a "Mnemónico" column), `missing_variable_column` (CSV without `variable`), `bad_type` (with `line` and `value`) or `empty`.
- Returns the summary: `{ id, surveyId, name, fileName, format, createdAt, tables: [{ name, variableCount }], datasets: [{ id, name, year, table }] }`. `format` is `inegi` or `csv`; `datasets` are the editions that use it.

`GET .../codebooks` returns `{ survey, items }` with one summary per dictionary, by name. `GET /harmonizer/codebooks/:codebookId` returns the summary with each table's `variables` (`{ name, label, question, section, declaredType, validRange, length, categories }`, in file order). `DELETE` deletes it; editions that used it are left without a dictionary, and their mappings and recodings do not change. Unknown dictionaries return `404 codebook_not_found`.

`PUT /harmonizer/datasets/:datasetId/codebook` takes `{ codebookId, table? }`:

- `codebookId: null` detaches the dictionary and returns `{ codebook: null }`.
- The dictionary must belong to the edition's survey (`404 codebook_not_found`).
- Without `table`, the table that has most of the edition's columns is used (ties by name). A `table` the dictionary does not have returns `400 codebook_table_not_found` with the `tables` it has. If no column of the edition is in the table, it returns `400 codebook_no_match` and nothing changes.
- A column is found in the table by its exact name or, if there is none, ignoring case.
- Returns `{ codebook: { id, name, table, matchedColumns, unmatchedColumns } }`.

The INEGI descriptors list the "No especificado" codes of most variables but not all of them: in the 2010 descriptor, `EDAD` gives `{000..130,999}` as its range without saying that `999` is "No especificado", so it is not proposed and has to be written in the mapping.

### Codes between editions

The harmonizer lines up the names of variables, not their codes. Joining years can mix codes that mean different things (report H-02 / SDI-50): in the census, `CLAVIVP` `2` is "Departamento en edificio" in 2010 and "Casa que comparte terreno" in 2020, and `SERSALUD` `09` is "No se atiende" in 2010 and "Otro lugar" in 2020.

For each canonical variable, the values of each edition that maps it are compared, with the labels of each edition's dictionary and the variable's recoding. The values come from a **profile** of each column: its distinct trimmed values with their counts (the 200 most frequent), and its empty cells. Data never changes after upload, so the profile is computed once with DuckDB, at upload or the first time it is needed, and stored in the database.

Codes are compared without leading zeros when they are numbers (`1`, `01` and `001` are the same code) and labels without accents, case or punctuation. Each edition's "No especificado" codes are left out. These differences are reported (`issues`):

| `kind` | Meaning |
| --- | --- |
| `label_conflict` | The same code has different labels in different editions. Needs labels in at least two editions. |
| `code_conflict` | The same label has different codes in different editions. |
| `format` | The same code is written differently (`040` and `40`). For a variable that is not categorical, it is reported once, with examples, and only if the variable is exported as text; as a number the difference disappears. |
| `only_in_some` | A code appears in the data of some editions but not of others. Often correct (a new category, or one nobody chose that year), which is why it can be marked as reviewed. |
| `not_in_catalog` | With a catalog, a value that was not recoded to one of its codes. |

A variable is **categorical** when it has a catalog, when the dictionary of an edition gives it two or more coded categories, or, without that, when every edition has at most 30 distinct values. Only categorical variables are checked for `label_conflict`, `code_conflict` and `only_in_some`. At most 50 issues of each kind are listed.

Each variable's `status` is `single` (fewer than two editions map it), `ok` (no differences), `warning` (differences nobody reviewed) or `reviewed`.

`GET .../variables` adds to each item `description`, `categories` (its catalog, `[]` if none) and `comparison: { status, issueCount }`.

`GET .../variables/:variableId/comparison` returns:

- `variable`: `{ id, name, description, dataType, categories, reviewedAt, reviewedBy }`.
- `status`, `categorical` and `issues` (`[{ kind, subject, editions: [{ datasetName, year, codes, label }] }]`; `subject` is the code, or the shared label for `code_conflict`).
- `editions`: for each mapping, ordered by year and upload time, `{ datasetId, datasetName, year, column, codebookLabel, values, distinctCapped, empty }`. Each value is `{ value, code, label, sourceLabel, count, missing, recoded }`: `value` as in the file, `code` as in the harmonized view, `label` from the catalog when recoded and otherwise from the edition's dictionary, `sourceLabel` from the edition's dictionary.
- `suggestion`: a proposed recoding, `{ categories, valueMaps: { <datasetId>: { <value>: <code> } } }`. The catalog is the saved one or, without one, the categories of the most recent edition whose dictionary has them (or that edition's values when no edition has a dictionary). Each value of each edition is proposed to the category with the same label, or with a label that starts the same when only one does ("Vivienda en vecindad" → "Vivienda en vecindad o cuartería"), or to the same code written differently (`1` → `01`) when the labels do not contradict it. Anything else is left for the user. Nothing is saved.

**Review.** `POST .../review` stores a signature (a hash) of the current differences, with the time and the reviewer's email, and returns the comparison. While the differences stay the same, the status is `reviewed` and the variable does not appear in `codeWarnings`. When they change (another mapping, other missing codes, another recoding, an edition added or removed), the signature no longer matches and the status goes back to `warning`; going back to the reviewed state restores it. A variable with no differences returns `409 variable_has_no_differences`. `DELETE .../review` removes the review.

### Recoding

`PUT .../variables/:variableId/recoding` takes `{ categories: [{ code, label? }], editions: [{ datasetId, values: [{ from, to }] }] }` and returns the new comparison:

- `categories` is the variable's catalog: the common codes and their labels. `[]` removes it. Codes are trimmed, cannot be empty (`problem: empty_code`) or repeated (`duplicate_code`).
- Each `editions` entry replaces the recoding of that edition's column; editions that are not sent keep theirs. The edition must map the variable (`edition_not_mapped`). Each `from` is a value as it appears in the file (trimmed) and `to` its common code. Entries with an empty `from` or `to` are ignored, a `from` cannot appear twice (`duplicate_value`), and with a catalog every `to` must be one of its codes (`target_not_in_catalog`). These errors are `400 recoding_invalid` with `params.problem`.
- A value recoded to itself (`05` → `05`) is kept: it says the value was checked against the catalog, so its label is the catalog's and it is no longer compared with the label of its own dictionary.
- If the variable's type is confirmed as `integer` or `decimal`, the recoded values must fit it (`400 value_type_mismatch` with `source: "recoding"`), so a recoding can also turn `100 y mas` into `100`.
- The recoding is applied in the views and exports after the missing codes and before the type.

`GET /harmonizer/surveys/:surveyId/catalog.csv` returns every catalog of the survey as CSV (UTF-8 with BOM, formula neutralization as in the exports): `variable, descripcion, codigo, etiqueta`, one row per category, variables in alphabetical order.

### Original file

`GET /harmonizer/datasets/:datasetId/original.csv` returns the uploaded file.

For a CSV uploaded with tus (plain or `.csv.gz`), the original is kept gzip-compressed and this returns it byte for byte as it was uploaded (decompressed when it was a `.csv.gz`): same encoding marks, separators, line endings and quoting. It is streamed, so it has no row limit.

For editions uploaded in one request or as DBF, the bytes of the upload are not kept, and the file is rebuilt from the edition's stored Parquet. It is the same data, not the same file:

- Every column of the file, mapped or not, in header order, with every data row in file order.
- Values exactly as read: no mapping, no `missingCodes` (codes such as `9` stay `9`), no type conversion, and no formula neutralization (a value `=1+1` is downloaded as `=1+1`, as it was uploaded).
- Headers are the stored ones, so they carry the changes made at upload: trimmed, repeated names renamed (`EDAD.1`) and empty headers named `columna_N`.
- Differences from the uploaded bytes: UTF-8 with a BOM, comma separator, `\n` line endings, values quoted only when needed, and blank lines dropped.
- The filename is `original_<edition>_<year>.csv`, with accents and symbols removed. The name of the uploaded file is not stored.
- An unknown edition returns `404 harmonizer_dataset_not_found`.
- A value that starts with a BOM character (U+FEFF) keeps it, as everywhere else: the paged JSON views and the downloads return text exactly as stored. (Before 2026-11-12 the DuckDB client for Node removed a leading BOM from every text it read, so the JSON views, the value profiles and column names read through DuckDB lost it; the server now keeps it, see `src/modules/analysis/duckdb-text.ts`.)
- The file is rebuilt without loading the rows into the server: the header line is written by the CSV writer and the rows by DuckDB, with the same quoting (see [Exports](#harmonized-views)), to a temporary file that is sent and then deleted, so it has no row limit.

### Direct downloads

A browser can only save a file as it arrives when it opens a link, and a link cannot carry the session (`Authorization: Bearer …`). With `fetch`, the whole file has to fit in the browser's memory first, which a census file of several GB does not. So a download takes two steps:

1. `POST` to the download's path plus `/download`, with the session: `.../datasets/:datasetId/harmonized.csv/download` (or `.parquet`), `.../datasets/:datasetId/original.csv/download`, or `.../surveys/:surveyId/harmonized.csv/download` (or `.parquet`, with the same `variables` query as the `GET`). The server prepares the same file as the `GET` and answers `201 { url, filename, size, expiresAt }`. Every error of the `GET` comes back here, as a normal JSON response, before anything is downloaded.
2. The browser opens `url` (`/harmonizer/downloads/<token>`, relative to the API), which needs no session: the token is the permission. It answers the file as an attachment, with `Content-Length` when `size` is known (`size` is `null` for a kept original of a tus upload, which is unzipped as it is sent), `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

- The token is random (256 bits) and works **once**: the second request, or one after `expiresAt` (15 minutes), returns `404 download_not_found`. A download cut half way cannot be resumed; prepare it again.
- A prepared file waits in the server's temporary folder (`ibero-harmonized-<id>.<ext>`) and is deleted once it is sent or when it expires. When the API stops (`SIGTERM`, `SIGINT`), it deletes every file still waiting or being sent before it exits; a download being sent is cut, and its token is gone. Files that a stopped or crashed API could not delete are deleted at the next start and every 15 minutes after that, once they are more than 75 minutes old. Files the API is still holding are never touched.
- Prepared downloads are kept in the API's memory, so they only work with one API process.
- Preparing takes as long as generating the file: about 20 seconds for the national census edition as Parquet. A proxy in front of the API must allow requests that long.
- The `GET` endpoints still send the file directly, with the session, for scripts.

## File storage

Files are written to `storage/` under the directory the server is started from. The folder is ignored by git.

| Path | Content |
| --- | --- |
| `storage/<datasetId>/<uuid>-<filename>` | Uploaded resources. Unsafe characters in the name become `_`. |
| `storage/analyses/<analysisId>.parquet` | Analysis results. |
| `storage/harmonizer/originals/<datasetId>.csv.gz` | The CSV of a harmonizer edition as it was uploaded with tus, gzip-compressed. |
| `storage/uploads/<importId>` and `<importId>.json` | A tus upload and its tus metadata, until the worker imports it (`UPLOAD_DIR`). |
| `storage/harmonizer/<datasetId>.parquet` | Rows of a harmonizer edition, all text, in file order. Columns are positional (`c0`, `c1`, …); their names are the edition's stored headers. Uploads are never empty now (see [Upload](#upload)), but an edition uploaded from an empty file before that rule (report H-08) has no headers and no Parquet, and reads as 0 rows. |

Column profiles (see [Codes between editions](#codes-between-editions)), column type checks (see [Variable types](#variable-types)) and dictionaries are stored in the database, not in `storage/`. Deleting an edition deletes its profiles and checks.

Deleting through the API removes the related files. A file deleted by hand makes its resource return `404 resource_file_missing`, and makes the views and exports of its harmonizer edition return `404 harmonizer_dataset_file_missing`.

Deleting an edition also deletes its kept original, with the same rules as its Parquet.

When the server starts, it cleans `storage/harmonizer/` (report SDI-100). It deletes every `<id>.parquet` or `<id>.parquet.deleting`, and every `originals/<id>.csv.gz(.deleting)`, whose edition no longer exists and that is more than an hour old (the worker writes an edition's files before it creates the edition). Those are files whose removal failed after the edition was deleted, files left by an interrupted upload, or files orphaned before SDI-100. A `.deleting` file whose edition still exists is renamed back. Other files in the folder are not touched. `storage/` is shared by `start:dev` and `start:local`, which use different databases, so if no file in the folder belongs to an edition of the current database, the cleanup assumes the folder belongs to the other database: it keeps everything and logs a warning. A failed cleanup is logged and never stops the server from starting.

---

## Open questions

The code currently behaves as described below. It is not yet decided whether each behavior is intended. When one is decided, update the relevant section and remove it from this list.

- **Private datasets.** `PRIVATE` only hides a dataset from the public catalog. Any logged-in user can still list and read it.
- **Harmonizer access.** Surveys are not tied to organizations, so every logged-in user can read and change all of them.
- **Login errors.** Different codes for an unknown email and a wrong password reveal which emails are registered.
- **Email format.** Registration only requires a non-empty email; the format is not checked.
- **Unused pieces.** `SysadminGuard` and the `PENDING` analysis status exist but are not used.
