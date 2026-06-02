const fs = require('fs');

const logPath = 'C:\\Users\\BerzanUnsal\\.gemini\\antigravity\\brain\\ed6d7fd3-f989-40ed-87ff-92c8439a817d\\.system_generated\\logs\\transcript.jsonl';
const fileContent = fs.readFileSync(logPath, 'utf8');
const lines = fileContent.split('\n');

const getArgVal = (args, key) => {
    const raw = args[key];
    if (raw === undefined) return '';
    try {
        return JSON.parse(raw);
    } catch (e) {
        if (raw.startsWith('"') && raw.endsWith('"')) {
            return raw.substring(1, raw.length - 1);
        }
        return raw;
    }
};

lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
        const obj = JSON.parse(line);
        if (obj.tool_calls) {
            obj.tool_calls.forEach(tc => {
                if (tc.name === 'replace_file_content') {
                    const args = tc.args || {};
                    const targetFile = getArgVal(args, 'TargetFile');
                    if (targetFile.includes('index.html')) {
                        const target = getArgVal(args, 'TargetContent');
                        const replacement = getArgVal(args, 'ReplacementContent');
                        const step = obj.step_index || index;
                        console.log(`Saving replace_file_content step ${step}`);
                        fs.writeFileSync(`C:\\Users\\BerzanUnsal\\.gemini\\antigravity\\brain\\ed6d7fd3-f989-40ed-87ff-92c8439a817d\\scratch\\step_${step}_target.txt`, target);
                        fs.writeFileSync(`C:\\Users\\BerzanUnsal\\.gemini\\antigravity\\brain\\ed6d7fd3-f989-40ed-87ff-92c8439a817d\\scratch\\step_${step}_replacement.txt`, replacement);
                    }
                } else if (tc.name === 'multi_replace_file_content') {
                    const args = tc.args || {};
                    const targetFile = getArgVal(args, 'TargetFile');
                    if (targetFile.includes('index.html')) {
                        const chunksRaw = args.ReplacementChunks;
                        let chunks = [];
                        try {
                            chunks = JSON.parse(chunksRaw);
                        } catch(e) {
                            chunks = chunksRaw;
                        }
                        const step = obj.step_index || index;
                        console.log(`Saving multi_replace_file_content step ${step} (${chunks.length} chunks)`);
                        chunks.forEach((chunk, cidx) => {
                            fs.writeFileSync(`C:\\Users\\BerzanUnsal\\.gemini\\antigravity\\brain\\ed6d7fd3-f989-40ed-87ff-92c8439a817d\\scratch\\step_${step}_chunk_${cidx}_target.txt`, chunk.TargetContent);
                            fs.writeFileSync(`C:\\Users\\BerzanUnsal\\.gemini\\antigravity\\brain\\ed6d7fd3-f989-40ed-87ff-92c8439a817d\\scratch\\step_${step}_chunk_${cidx}_replacement.txt`, chunk.ReplacementContent);
                        });
                    }
                }
            });
        }
    } catch (e) {
        console.error(`Error line ${index}: ${e.message}`);
    }
});
