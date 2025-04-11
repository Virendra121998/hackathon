// server.js
// Enhanced boilerplate for breaking down Figma into smaller components,
// checking them against a GitLab component library, generating missing ones,
// and committing them to a new branch.

const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ENV Variables
const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;

const openai = new OpenAI({ apiKey: "My API Key" });

// --- Endpoint 1: Parse Figma File and Break Down Components ---
app.post('/api/parse-figma', async (req, res) => {
  const { fileKey, nodeId } = req.body;
  try {
    // Get file data
    const fileResponse = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: { 'X-Figma-Token': FIGMA_TOKEN },
    });

    // Get specific node if nodeId is provided
    let nodeData;
    if (nodeId) {
      const nodeResponse = await axios.get(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`, {
        headers: { 'X-Figma-Token': FIGMA_TOKEN },
      });
      nodeData = nodeResponse.data.nodes[0].document;
    } else {
      nodeData = fileResponse.data.document;
    }

    const components = extractAllNestedComponents(nodeData);
    res.json({ 
      success: true,
      components,
      fileInfo: {
        name: fileResponse.data.name,
        lastModified: fileResponse.data.lastModified,
        version: fileResponse.data.version
      }
    });
  } catch (err) {
    console.error('Figma parsing error:', err.response?.data || err.message);
    res.status(500).json({ 
      error: 'Figma parsing failed', 
      details: err.response?.data || err.message 
    });
  }
});

function extractAllNestedComponents(document) {
  const components = [];
  function walk(node, parentPath = []) {
    if (node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'FRAME') {
      components.push({
        name: node.name,
        id: node.id,
        path: [...parentPath, node.name],
        type: node.type,
        description: node.description || '',
        width: node.absoluteBoundingBox?.width,
        height: node.absoluteBoundingBox?.height,
        children: node.children?.length || 0,
        styles: {
          backgroundColor: node.backgroundColor,
          opacity: node.opacity,
          effects: node.effects
        }
      });
    }
    if (node.children) {
      node.children.forEach(child => walk(child, [...parentPath, node.name]));
    }
  }
  walk(document);
  return components;
}

// --- Endpoint 2: Check GitLab for Component ---
app.post('/api/check-component', async (req, res) => {
  const { componentName } = req.body;
  try {
    const response = await axios.get(`https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/repository/tree?recursive=true`, {
      headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
    });
    const files = response.data.map(f => f.path);
    const exists = files.some(name => name.includes(componentName));
    res.json({ exists, files });
  } catch (err) {
    res.status(500).json({ error: 'GitLab check failed', details: err.message });
  }
});

// --- Endpoint 3: Generate Missing Components ---
app.post('/api/generate-component', async (req, res) => {
  const { componentStructure, componentName } = req.body;
  try {
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        { role: 'system', content: 'You are a senior frontend engineer who converts UI specs into small, reusable React components.' },
        { role: 'user', content: `Create a React component named '${componentName}' from this Figma structure:\n${JSON.stringify(componentStructure)}` }
      ]
    });
    const code = gptResponse.choices[0].message.content;
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: 'Component generation failed', details: err.message });
  }
});

// --- Endpoint 4: Commit Component to GitLab ---
app.post('/api/commit-component', async (req, res) => {
  const { branch, filePath, code, commitMessage } = req.body;
  try {
    await axios.post(`https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/repository/branches`, {
      branch,
      ref: 'main'
    }, {
      headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
    });

    await axios.post(`https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/repository/commits`, {
      branch,
      commit_message: commitMessage,
      actions: [{
        action: 'create',
        file_path: filePath,
        content: code,
      }],
    }, {
      headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'GitLab commit failed', details: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
