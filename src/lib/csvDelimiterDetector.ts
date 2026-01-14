/**
 * Detects the most likely delimiter in a CSV file by analyzing the first few KB.
 * Supports: comma (,), semicolon (;), tab (\t), pipe (|)
 */

const DELIMITERS = [',', ';', '\t', '|'] as const;
type Delimiter = typeof DELIMITERS[number];

interface DetectionResult {
  delimiter: Delimiter;
  confidence: 'high' | 'medium' | 'low';
  counts: Record<Delimiter, number>;
}

/**
 * Reads the first N bytes of a file and returns the text content
 */
async function readFileHead(file: File, maxBytes: number = 32768): Promise<string> {
  const slice = file.slice(0, maxBytes);
  const text = await slice.text();
  return text;
}

/**
 * Analyzes CSV content to detect the most likely delimiter
 */
function analyzeDelimiter(content: string): DetectionResult {
  // Split into lines, take first 20 non-empty lines for analysis
  const lines = content.split('\n').filter(line => line.trim().length > 0).slice(0, 20);
  
  if (lines.length === 0) {
    return { delimiter: ',', confidence: 'low', counts: { ',': 0, ';': 0, '\t': 0, '|': 0 } };
  }

  // Count occurrences of each delimiter per line
  const lineCounts: Record<Delimiter, number[]> = {
    ',': [],
    ';': [],
    '\t': [],
    '|': [],
  };

  for (const line of lines) {
    for (const delim of DELIMITERS) {
      // Count occurrences outside of quoted strings
      let count = 0;
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          // Handle escaped quotes
          if (inQuotes && line[i + 1] === '"') {
            i++; // Skip next quote
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === delim && !inQuotes) {
          count++;
        }
      }
      
      lineCounts[delim].push(count);
    }
  }

  // Calculate consistency score for each delimiter
  // A good delimiter should have consistent counts across lines
  const scores: Record<Delimiter, { total: number; consistency: number; avg: number }> = {
    ',': { total: 0, consistency: 0, avg: 0 },
    ';': { total: 0, consistency: 0, avg: 0 },
    '\t': { total: 0, consistency: 0, avg: 0 },
    '|': { total: 0, consistency: 0, avg: 0 },
  };

  for (const delim of DELIMITERS) {
    const counts = lineCounts[delim];
    const total = counts.reduce((a, b) => a + b, 0);
    const avg = total / counts.length;
    
    // Calculate variance - lower is better (more consistent)
    const variance = counts.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / counts.length;
    const stdDev = Math.sqrt(variance);
    
    // Consistency score: higher avg count with lower variance is better
    // Normalize by average to handle different magnitudes
    const consistency = avg > 0 ? avg / (1 + stdDev / avg) : 0;
    
    scores[delim] = { total, consistency, avg };
  }

  // Find the delimiter with the best consistency score (and at least 1 occurrence per line on average)
  let bestDelim: Delimiter = ',';
  let bestScore = 0;

  for (const delim of DELIMITERS) {
    const { consistency, avg } = scores[delim];
    // Must have at least 1 delimiter per line on average
    if (avg >= 1 && consistency > bestScore) {
      bestScore = consistency;
      bestDelim = delim;
    }
  }

  // Determine confidence based on score difference and consistency
  let confidence: 'high' | 'medium' | 'low' = 'low';
  
  const sortedScores = DELIMITERS
    .map(d => ({ delim: d, score: scores[d].consistency }))
    .sort((a, b) => b.score - a.score);

  if (sortedScores[0].score > 0) {
    const ratio = sortedScores[1].score > 0 
      ? sortedScores[0].score / sortedScores[1].score 
      : Infinity;
    
    if (ratio >= 2 && scores[bestDelim].avg >= 2) {
      confidence = 'high';
    } else if (ratio >= 1.3 || scores[bestDelim].avg >= 1) {
      confidence = 'medium';
    }
  }

  return {
    delimiter: bestDelim,
    confidence,
    counts: {
      ',': Math.round(scores[','].avg),
      ';': Math.round(scores[';'].avg),
      '\t': Math.round(scores['\t'].avg),
      '|': Math.round(scores['|'].avg),
    },
  };
}

/**
 * Detects the delimiter of a CSV file
 * @param file The CSV file to analyze
 * @returns Promise with detection result
 */
export async function detectCSVDelimiter(file: File): Promise<DetectionResult> {
  try {
    const content = await readFileHead(file);
    return analyzeDelimiter(content);
  } catch (error) {
    console.warn('Failed to detect CSV delimiter:', error);
    return { delimiter: ',', confidence: 'low', counts: { ',': 0, ';': 0, '\t': 0, '|': 0 } };
  }
}

/**
 * Detects delimiter from multiple files (uses the first file)
 */
export async function detectCSVDelimiterFromFiles(files: File[]): Promise<DetectionResult> {
  if (files.length === 0) {
    return { delimiter: ',', confidence: 'low', counts: { ',': 0, ';': 0, '\t': 0, '|': 0 } };
  }
  return detectCSVDelimiter(files[0]);
}
