/** Character trigrams permit partial matches across word forms and identifiers.
 * Document frequencies belong to this authorized collection only. */
function termFrequencies(text: string) {
  const frequencies = new Map<string, number>();
  for (const match of text.normalize("NFKC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const characters = Array.from(match[0]);
    const width = Math.min(characters.length, 3);
    for (let index = 0; index <= characters.length - width; index++) {
      const term = characters.slice(index, index + width).join("");
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  return frequencies;
}

export function passageCosines(passages: string[], query: string): number[] {
  const documents = passages.map(termFrequencies);
  const documentFrequency = new Map<string, number>();
  for (const terms of documents) {
    for (const term of terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  function tfidf(term: string, count: number) {
    const idf = 1 + Math.log((1 + documents.length) / (1 + (documentFrequency.get(term) ?? 0)));
    return (1 + Math.log(count)) * idf;
  }
  const queryWeights = new Map<string, number>();
  let querySquaredNorm = 0;
  for (const [term, count] of termFrequencies(query)) {
    const weight = tfidf(term, count);
    queryWeights.set(term, weight);
    querySquaredNorm += weight * weight;
  }
  return documents.map(terms => {
    let dot = 0;
    let squaredNorm = 0;
    for (const [term, count] of terms) {
      const weight = tfidf(term, count);
      dot += weight * (queryWeights.get(term) ?? 0);
      squaredNorm += weight * weight;
    }
    return squaredNorm && querySquaredNorm ? Math.min(1, dot / Math.sqrt(squaredNorm * querySquaredNorm)) : 0;
  });
}
