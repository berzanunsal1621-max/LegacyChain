const path = require("path");
const express = require("express");

const app = express();
const port = Number(process.env.FRONTEND_PORT || 8080);
const root = path.join(__dirname, "..");

app.use(express.static(root, {
    extensions: ["html"],
    setHeaders(res) {
        res.setHeader("Cache-Control", "no-store");
    },
}));

app.get("/", (_req, res) => {
    res.sendFile(path.join(root, "index.html"));
});

app.listen(port, () => {
    console.log(`LegacyChain frontend running at http://localhost:${port}`);
});
