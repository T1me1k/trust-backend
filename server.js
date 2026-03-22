const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const launcherConfig = {
  appName: "TRUST",
  minSupportedVersion: "0.1.0",
  latestVersion: "0.1.0",
  matchmakingEnabled: true,
  maintenance: false,
  motd: "Welcome to TRUST alpha",
  news: [
    {
      id: 1,
      title: "Alpha is live",
      body: "Main launcher flow is now available."
    },
    {
      id: 2,
      title: "2x2 and 5x5 enabled",
      body: "Core queue modes are available in the current build."
    }
  ]
};

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "trust-backend",
    message: "TRUST backend is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    timestamp: Date.now()
  });
});

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    version: launcherConfig.latestVersion,
    minSupportedVersion: launcherConfig.minSupportedVersion
  });
});

app.get("/motd", (req, res) => {
  res.json({
    ok: true,
    motd: launcherConfig.motd
  });
});

app.get("/config", (req, res) => {
  res.json({
    ok: true,
    config: launcherConfig
  });
});

app.listen(PORT, () => {
  console.log(`TRUST backend running on port ${PORT}`);
});
