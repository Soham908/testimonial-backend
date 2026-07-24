// Mirrors PLACEHOLDER_QUESTIONS in the mobile app — keep both in sync.
// Only 1-3 are active; 4-5 are reserved for when the mobile app re-enables them.
export const QUESTION_TEXT: Partial<Record<number, string>> = {
  1: "What made you choose to work with us?",
  2: "What results have you seen so far?",
  3: "How has our support been for you?",
  // 4: "What would you say to someone considering us?",
  // 5: "Anything else you would like to share?",
};

// Static, pre-recorded AI voice-over reading each question aloud — one file
// per question, reused across every distributor's render of that question
// (not derived per-segment). Uploaded once to a static S3 path; see
// BUILD_STEPS.md step 7 for how these got there.
export const QUESTION_VO_KEY: Partial<Record<number, string>> = {
  1: "static/question-vo/1.mp3",
  2: "static/question-vo/2.mp3",
  3: "static/question-vo/3.mp3",
  // 4: "static/question-vo/4.mp3",
  // 5: "static/question-vo/5.mp3",
};
