// Builds samples/welcome.pdf: a synthetic 2-page test document with a heading,
// several paragraphs, a word hyphenated across a line end, and numbers.
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";

const pdf = await PDFDocument.create();
const body = await pdf.embedFont(StandardFonts.TimesRoman);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

const pages = [
  [
    ["h", "Welcome to ReadAloud"],
    ["p", "This is a small test document. It has a heading, a few paragraphs, and a second page. Press play, and the voice will read it to you while each word lights up."],
    ["p", "Reading and listening at the same time is called bimodal reading. Many people find that it helps them focus, remember more, and get through long documents faster than with their eyes alone."],
    ["p", "You can change the speed at any time. Try one and a half times, then two times. The voice keeps its pitch, so it never sounds like a cartoon. Click any word to jump there."],
    ["hy", ["The text view lets you pick a font, a size, and a theme. It also joins words that were split at the end of a line, like this inter-", "national example, so the voice reads them as one word."]],
  ],
  [
    ["h", "How it works"],
    ["p", "First, the PDF is opened in your browser and its text pieces are grouped into words, lines, paragraphs, and sentences."],
    ["p", "Next, each sentence is sent to a voice model that runs on your own computer. The model returns audio and the timing of every word."],
    ["p", "Finally, while the audio plays, the app checks the current time about sixty times per second and highlights the word being spoken. In 2026 this all runs offline, with no account and no cloud."],
  ],
];

function wrap(text, font, size, width) {
  const lines = [];
  let line = "";
  for (const w of text.split(" ")) {
    const test = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

for (const blocks of pages) {
  const page = pdf.addPage([612, 792]);
  let y = 720;
  for (const [kind, text] of blocks) {
    if (kind === "h") {
      page.drawText(text, { x: 72, y, size: 22, font: bold });
      y -= 40;
    } else if (kind === "hy") {
      const [a, b] = text;
      const la = wrap(a, body, 13, 468);
      const lb = wrap(b, body, 13, 468);
      for (const l of [...la, ...lb]) {
        page.drawText(l, { x: 72, y, size: 13, font: body });
        y -= 18;
      }
      y -= 12;
    } else {
      for (const l of wrap(text, body, 13, 468)) {
        page.drawText(l, { x: 72, y, size: 13, font: body });
        y -= 18;
      }
      y -= 12;
    }
  }
}
await writeFile("samples/welcome.pdf", await pdf.save());
console.log("wrote samples/welcome.pdf");
