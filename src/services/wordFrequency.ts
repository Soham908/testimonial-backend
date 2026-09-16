// Code-only word-frequency computation for the wordcloud dashboard endpoint —
// no LLM involved. Transcripts in this app are frequently code-mixed
// (English/Hindi/Marathi in the same sentence — see CLAUDE.md/BUILD_STEPS.md
// notes on this), so tokenizing/filtering can't key off Distributor.
// language_pref or Transcript.language_detected to pick "the" stopword list —
// a single detected language tag doesn't mean the text is monolingual. The
// union of all three languages' stopword sets is applied to every token
// instead, regardless of the source segment's detected language.

// Matches a run of letters + combining marks (Unicode word segments) —
// covers both Latin words and Devanagari akshara clusters (base consonant/
// vowel + matras + virama), which a plain [a-zA-Z]+ pattern would mangle.
// Deliberately excludes digits and punctuation — this is a word cloud, not a
// full tokenizer.
const WORD_PATTERN = /[\p{L}\p{M}]+/gu;

const MIN_TOKEN_LENGTH = 2;

// Reasonably standard, not exhaustively corpus-verified — a solid starting
// set per language, easy to extend later if specific noise words show up in
// real wordcloud output.
const STOPWORDS_EN = new Set([
  "a","about","above","after","again","all","am","an","and","any","are","aren't","as","at",
  "be","because","been","before","being","below","between","both","but","by",
  "can","cant","cannot","could","couldn't",
  "did","didn't","do","does","doesn't","doing","don","don't","down","during",
  "each","few","for","from","further",
  "had","hadn't","has","hasn't","have","haven't","having","he","he'd","he'll","he's","her","here","here's","hers","herself","him","himself","his","how","how's",
  "i","i'd","i'll","i'm","i've","if","in","into","is","isn't","it","it's","its","itself",
  "just","let's",
  "me","more","most","mustn't","my","myself",
  "no","nor","not","now",
  "of","off","on","once","only","or","other","ought","our","ours","ourselves","out","over","own",
  "same","shan't","she","she'd","she'll","she's","should","shouldn't","so","some","such",
  "than","that","that's","the","their","theirs","them","themselves","then","there","there's","these","they","they'd","they'll","they're","they've","this","those","through","to","too",
  "under","until","up",
  "very",
  "was","wasn't","we","we'd","we'll","we're","we've","were","weren't","what","what's","when","when's","where","where's","which","while","who","who's","whom","why","why's","with","won't","would","wouldn't",
  "you","you'd","you'll","you're","you've","your","yours","yourself","yourselves",
  "um","uh","like","yeah","okay","ok","actually","basically","literally",
]);

const STOPWORDS_HI = new Set([
  "और","का","के","की","को","ने","में","है","हैं","हूँ","हूं","था","थे","थी","हो","होता","होती","होते","होगा","होगी",
  "यह","ये","वह","वे","इस","उस","इन","उन","जो","जिस","जिन","जिसे","कि","तो","भी","ही","से","पर",
  "ना","नहीं","न","मत","क्या","कौन","कैसे","कहाँ","कब","क्यों","किस","किसे","किसी","कोई",
  "एक","दो","सब","सभी","कुछ","अपना","अपने","अपनी","हम","हमारा","हमारे","हमारी",
  "तुम","तुम्हारा","तुम्हारे","आप","आपका","आपके","आपकी","मैं","मेरा","मेरे","मेरी",
  "वो","उसका","उसके","उसकी","इसका","इसके","इसकी","इसमें","उसमें",
  "लिए","साथ","बाद","पहले","अभी","फिर","वहाँ","यहाँ","तक","बिना","जैसे","तरह",
  "तथा","एवं","अगर","यदि","लेकिन","परंतु","किन्तु","या","अथवा","सकता","सकती","सकते",
  "रहा","रही","रहे","गया","गयी","गई","गए","दिया","दी","दिए","करना","करता","करती","करते","किया","की","किए",
]);

const STOPWORDS_MR = new Set([
  "आणि","व","तसेच","किंवा","पण","परंतु","तर","आहे","आहेत","होता","होती","होते","होतो",
  "असे","असा","अशी","असतो","असते","हा","ही","हे","त्या","त्याचा","त्याची","त्याचे","त्याला",
  "तो","ती","ते","या","याचा","याची","याचे","याला","मी","माझा","माझी","माझे","माझ्या",
  "आम्ही","आमचा","आमची","आमचे","तुम्ही","तुमचा","तुमची","तुमचे","तू","तुझा","तुझी","तुझे",
  "काय","कोण","कसे","कसा","कशी","कुठे","कधी","का","किती","एक","दोन","सर्व","सगळे","काही","कोणी",
  "स्वतःचा","स्वतःची","स्वतःचे","साठी","मध्ये","वर","नंतर","आधी","आता","पुन्हा","तिथे","इथे",
  "पर्यंत","शिवाय","प्रमाणे","म्हणून","जर","तरी","नाही","नका","ना","होणार","झाला","झाली","झाले",
  "करतो","करते","करतात","केला","केली","केले","असलेला","असलेली","असलेले",
]);

const ALL_STOPWORDS = new Set([...STOPWORDS_EN, ...STOPWORDS_HI, ...STOPWORDS_MR]);

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(WORD_PATTERN) ?? [];
  return matches.filter((word) => word.length >= MIN_TOKEN_LENGTH && !ALL_STOPWORDS.has(word));
}

export type WordCount = { word: string; count: number };

export function computeWordFrequency(texts: string[], limit: number): WordCount[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const word of tokenize(text)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}
