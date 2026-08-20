# Transcript API

This local API returns meeting records for client-context ingestion tests. The API is intentionally small

## To run

```
node api_stub_server.js
```

## Base URL

```text
http://127.0.0.1:8000
```

## List Meetings

```http
GET /v1/meetings
```

Returns meeting metadata in fixture order. Clients should not assume chronological ordering.

### Query Parameters

| Name | Type | Description |
| --- | --- | --- |
| `created_after` | date or date-time | Return meetings created after this value. |
| `created_before` | date or date-time | Return meetings created before this value. |
| `updated_after` | date or date-time | Return meetings updated after this value. |

### Response

```json
{
  "meetings": [
    {
      "id": "mtg_acme2026052001",
      "owner": {
        "name": "Avery Stone",
        "email": "avery.stone@corridoradvisors.com"
      },
      "created_at": "2026-05-20T19:00:00Z",
      "updated_at": "2026-05-20T20:10:00Z"
    }
  ]
}
```

## Get Meeting

```http
GET /v1/meetings/{meeting_id}
```

Returns one meeting, always including the transcript.

### Response

```json
{
  "id": "mtg_acme2026052001",
  "owner": {
    "name": "Avery Stone",
    "email": "avery.stone@corridoradvisors.com"
  },
  "created_at": "2026-05-20T19:00:00Z",
  "updated_at": "2026-05-20T20:10:00Z",
  "attendees": [
    {
      "name": "Priya Shah",
      "email": "priya.shah@acme.example"
    }
  ],
  "transcript": [
    {
      "speaker": {
        "name": "Priya Shah",
        "email": "priya.shah@acme.example",
        "source": "microphone"
      },
      "text": "For Acme Benefits, the 27 figure included contractors by mistake. The corrected employee count is 26.",
      "start_time": "2026-05-20T19:08:00Z",
      "end_time": "2026-05-20T19:08:14Z"
    }
  ]
}
```

## Errors

```json
{
  "error": {
    "type": "not_found_error",
    "message": "No meeting found for id mtg_missing000001"
  }
}
```
