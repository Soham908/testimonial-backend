import { describe, expect, it } from "vitest";
import { computeWordFrequency, tokenize } from "../src/services/wordFrequency";

describe("tokenize", () => {
  it("lowercases, strips punctuation, and drops English stopwords", () => {
    const words = tokenize("The teacher was REALLY great, and I still remember her.");
    expect(words).toEqual(["teacher", "really", "great", "still", "remember"]);
  });

  it("tokenizes Devanagari (Hindi) text and drops Hindi stopwords", () => {
    // "the teacher taught us a lot" (rough) - "ने", "को", "बहुत" are function
    // words that should be filtered, "शिक्षक"/"सिखाया" are content words.
    const words = tokenize("शिक्षक ने हमें बहुत कुछ सिखाया");
    expect(words).toContain("शिक्षक");
    expect(words).toContain("सिखाया");
    expect(words).not.toContain("ने");
    expect(words).not.toContain("को");
  });

  it("handles code-mixed English/Hindi in one transcript without a language hint", () => {
    const words = tokenize("मेरी school life was बहुत अच्छी honestly");
    expect(words).toContain("school");
    expect(words).toContain("honestly");
    expect(words).toContain("अच्छी");
    expect(words).not.toContain("मेरी");
    expect(words).not.toContain("was");
  });

  it("drops tokens shorter than 2 characters", () => {
    expect(tokenize("a i o u")).toEqual([]);
  });
});

describe("computeWordFrequency", () => {
  it("counts across multiple transcripts and sorts descending", () => {
    const result = computeWordFrequency(
      ["teacher taught confidence", "teacher taught discipline", "teacher inspired me"],
      10,
    );
    expect(result[0]).toEqual({ word: "teacher", count: 3 });
    expect(result.find((w) => w.word === "taught")).toEqual({ word: "taught", count: 2 });
  });

  it("respects the limit", () => {
    const result = computeWordFrequency(["alpha beta gamma delta epsilon"], 2);
    expect(result).toHaveLength(2);
  });

  it("returns an empty array for no input", () => {
    expect(computeWordFrequency([], 10)).toEqual([]);
  });
});
