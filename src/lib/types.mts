/** Shapes returned by the transcript API stub (api.md). */

export interface Person {
  name: string;
  email: string;
}

export interface TranscriptTurn {
  speaker: Person & { source: string };
  text: string;
  start_time: string;
  end_time: string;
}

export interface MeetingListItem {
  id: string;
  owner: Person;
  created_at: string;
  updated_at: string;
}

export interface Meeting extends MeetingListItem {
  attendees: Person[];
  transcript: TranscriptTurn[];
}

export interface ApiError {
  error: {
    type: string;
    message: string;
  };
}
