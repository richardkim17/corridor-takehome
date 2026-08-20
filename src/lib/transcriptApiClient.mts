import type { ApiError, Meeting, MeetingListItem } from "./types.mjs";

export class TranscriptApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly type?: string,
  ) {
    super(message);
    this.name = "TranscriptApiError";
  }
}

function baseUrl(): string {
  return process.env.TRANSCRIPT_API_BASE_URL ?? "http://127.0.0.1:8000";
}

async function request<T>(pathAndQuery: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${pathAndQuery}`);
  } catch (err) {
    throw new TranscriptApiError(
      `Could not reach transcript API at ${baseUrl()}: ${(err as Error).message}`,
    );
  }

  const body = await res.json().catch(() => undefined);

  if (!res.ok) {
    const apiErr = body as ApiError | undefined;
    throw new TranscriptApiError(
      apiErr?.error?.message ?? `Transcript API returned HTTP ${res.status}`,
      res.status,
      apiErr?.error?.type,
    );
  }

  return body as T;
}

/** GET /v1/meetings, optionally filtered by updated_after (ISO-8601). */
export async function listMeetings(params?: {
  updatedAfter?: string;
}): Promise<MeetingListItem[]> {
  const qs = new URLSearchParams();
  if (params?.updatedAfter) qs.set("updated_after", params.updatedAfter);
  const query = qs.toString() ? `?${qs.toString()}` : "";
  const { meetings } = await request<{ meetings: MeetingListItem[] }>(
    `/v1/meetings${query}`,
  );
  return meetings;
}

/** GET /v1/meetings/{id} — full meeting including transcript. Throws
 * TranscriptApiError(status=404) if the meeting doesn't exist. */
export async function getMeeting(meetingId: string): Promise<Meeting> {
  return request<Meeting>(`/v1/meetings/${encodeURIComponent(meetingId)}`);
}
