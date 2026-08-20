const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8000);
const DATA_FILE =
  process.env.STUB_DATA_FILE || path.join(__dirname, "dummy_data.txt");

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });
  res.end(JSON.stringify(body, null, 2));
}

function loadMeetings() {
  const fixture = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!Array.isArray(fixture.meetings)) {
    throw new Error("Fixture must contain a meetings array");
  }
  return fixture.meetings;
}

function meetingListItem(meeting) {
  return {
    id: meeting.id,
    owner: meeting.owner,
    created_at: meeting.created_at,
    updated_at: meeting.updated_at,
  };
}

function filterMeetings(meetings, searchParams) {
  return meetings.filter((meeting) => {
    const createdAt = Date.parse(meeting.created_at);
    const updatedAt = Date.parse(meeting.updated_at);
    const createdAfter = searchParams.get("created_after");
    const createdBefore = searchParams.get("created_before");
    const updatedAfter = searchParams.get("updated_after");

    if (createdAfter && createdAt <= Date.parse(createdAfter)) {
      return false;
    }
    if (createdBefore && createdAt >= Date.parse(createdBefore)) {
      return false;
    }
    if (updatedAfter && updatedAt <= Date.parse(updatedAfter)) {
      return false;
    }

    return true;
  });
}

function handleListMeetings(req, res, url) {
  const filteredMeetings = filterMeetings(loadMeetings(), url.searchParams);

  sendJson(res, 200, {
    meetings: filteredMeetings.map(meetingListItem),
  });
}

function handleGetMeeting(req, res, meetingId) {
  const meeting = loadMeetings().find(
    (candidate) => candidate.id === meetingId,
  );
  if (!meeting) {
    sendJson(res, 404, {
      error: {
        type: "not_found_error",
        message: `No meeting found for id ${meetingId}`,
      },
    });
    return;
  }

  sendJson(res, 200, meeting);
}

function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/meetings") {
      handleListMeetings(req, res, url);
      return;
    }

    const meetingMatch = url.pathname.match(/^\/v1\/meetings\/([^/]+)$/);
    if (req.method === "GET" && meetingMatch) {
      handleGetMeeting(req, res, meetingMatch[1]);
      return;
    }

    sendJson(res, 404, {
      error: {
        type: "not_found_error",
        message: `No stub route for ${req.method} ${url.pathname}`,
      },
    });
  } catch (error) {
    sendJson(res, 500, {
      error: {
        type: "stub_error",
        message: error.message,
      },
    });
  }
}

http.createServer(handleRequest).listen(PORT, "127.0.0.1", () => {
  console.log(`Transcript API stub listening on http://127.0.0.1:${PORT}`);
  console.log(`Using fixture data from ${DATA_FILE}`);
});
