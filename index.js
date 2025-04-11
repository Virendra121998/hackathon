// server.js
// Enhanced boilerplate for breaking down Figma into smaller components,
// checking them against a GitLab component library, generating missing ones,
// and committing them to a new branch.

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Validate required environment variables
const requiredEnvVars = ['FIGMA_TOKEN', 'OPENAI_API_KEY', 'GITLAB_TOKEN', 'GITLAB_PROJECT_ID'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

// ENV Variables
const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;

const openai = new OpenAI({ apiKey: `${OPENAI_API_KEY}` });

function isAtomicComponent(node) {
  // List of common atomic component patterns
  const atomicPatterns = [
    'button', 'input', 'text', 'icon', 'image', 'avatar', 'badge',
    'statusbar', 'header', 'footer', 'card', 'list', 'tab', 'modal',
    'checkbox', 'radio', 'switch', 'slider', 'progress', 'spinner'
  ];

  const name = node.name.toLowerCase();
  
  // Check if it's a component or instance
  const isComponent = node.type === 'COMPONENT' || node.type === 'INSTANCE';
  
  // Check if it matches atomic patterns
  const isAtomic = atomicPatterns.some(pattern => name.includes(pattern));
  
  // Check if it's a small, reusable element (based on size)
  const isSmall = node.absoluteBoundingBox?.width < 500 && 
                 node.absoluteBoundingBox?.height < 500;

  return isComponent && (isAtomic || isSmall);
}

function isScreenOrFrame(node) {
  // List of patterns that indicate a screen or frame
  const screenPatterns = [
    'page', 'screen', 'view', 'layout', 'container', 'section',
    'home', 'dashboard', 'profile', 'settings'
  ];

  const name = node.name.toLowerCase();
  const isFrame = node.type === 'FRAME';
  const isScreen = screenPatterns.some(pattern => name.includes(pattern));
  const isLarge = node.absoluteBoundingBox?.width >= 500 || 
                 node.absoluteBoundingBox?.height >= 500;

  return (isFrame && (isScreen || isLarge));
}

function extractAllNestedComponents(document) {
  const components = [];
  const screens = [];

  function walk(node, parentPath = []) {
    if (isAtomicComponent(node)) {
      components.push({
        name: node.name,
        id: node.id,
        path: [...parentPath, node.name],
        type: node.type,
        category: determineComponentCategory(node),
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
    } else if (isScreenOrFrame(node)) {
      screens.push({
        name: node.name,
        id: node.id,
        type: 'SCREEN',
        width: node.absoluteBoundingBox?.width,
        height: node.absoluteBoundingBox?.height
      });
    }

    if (node.children) {
      node.children.forEach(child => walk(child, [...parentPath, node.name]));
    }
  }

  function determineComponentCategory(node) {
    const name = node.name.toLowerCase();
    
    if (name.includes('statusbar')) return 'STATUS_BAR';
    if (name.includes('button')) return 'BUTTON';
    if (name.includes('input') || name.includes('textfield')) return 'INPUT';
    if (name.includes('text')) return 'TEXT';
    if (name.includes('icon')) return 'ICON';
    if (name.includes('image')) return 'IMAGE';
    if (name.includes('avatar')) return 'AVATAR';
    if (name.includes('badge')) return 'BADGE';
    if (name.includes('card')) return 'CARD';
    if (name.includes('list')) return 'LIST';
    if (name.includes('tab')) return 'TAB';
    if (name.includes('modal')) return 'MODAL';
    
    return 'OTHER';
  }

  walk(document);
  
  return {
    atomicComponents: components,
    screens: screens
  };
}

// --- Endpoint 1: Parse Figma File and Break Down Components ---
app.post('/api/parse-figma', async (req, res) => {
  const { fileKey, nodeId } = req.body;
  
  // Validate token
  if (!FIGMA_TOKEN) {
    return res.status(500).json({ 
      error: 'Configuration error',
      details: 'FIGMA_TOKEN is not set in environment variables'
    });
  }

  try {
    console.log('Attempting to fetch Figma file with token:', FIGMA_TOKEN.substring(0, 10) + '...');
    
    // Get file data
    const fileResponse = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: { 
        'X-Figma-Token': FIGMA_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    // Get specific node if nodeId is provided
    let nodeData;
    if (nodeId) {
      const nodeResponse = await axios.get(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`, {
        headers: { 
          'X-Figma-Token': FIGMA_TOKEN,
          'Content-Type': 'application/json'
        }
      });
      nodeData = nodeResponse.data.nodes[0].document;
    } else {
      nodeData = fileResponse.data.document;
    }

    const { atomicComponents, screens } = extractAllNestedComponents(nodeData);
    
    res.json({ 
      success: true,
      components: atomicComponents,
      screens: screens,
      fileInfo: {
        name: fileResponse.data.name,
        lastModified: fileResponse.data.lastModified,
        version: fileResponse.data.version
      }
    });
  } catch (err) {
    console.error('Figma API Error:', {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      message: err.message
    });
    
    res.status(err.response?.status || 500).json({ 
      error: 'Figma parsing failed', 
      details: {
        status: err.response?.status,
        message: err.response?.data?.message || err.message
      }
    });
  }
});

// --- Endpoint 2: Check GitLab for Component ---
app.post('/api/check-component', async (req, res) => {
  const { componentName, figmaComponents } = req.body;
  try {
    // First get the repository tree from GitLab
    const response = await axios.get(`https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/repository/tree?recursive=true`, {
      headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
    });
    
    // Find the registry file in the response
    const registryFile = response.data.find(file => 
      file.path === 'packages/src/customer/vdlComponents/registry.ts'
    );

    if (!registryFile) {
      return res.json({ 
        exists: false, 
        message: 'Registry file not found in repository',
        files: response.data.map(f => f.path),
        newComponents: figmaComponents // If no registry, all components are new
      });
    }

    // Get the content of the registry file
    const registryContentResponse = await axios.get(
      `https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(registryFile.path)}/raw`,
      {
        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
      }
    );

    const registryContent = registryContentResponse.data;
    
    // Check if component exists in registry
    const componentExists = registryContent.includes(componentName);
    
    // Find new components by comparing with registry
    const newComponents = figmaComponents.filter(component => {
      const componentName = component.name.toLowerCase();
      return !registryContent.toLowerCase().includes(componentName);
    });
    
    res.json({ 
      exists: componentExists,
      message: componentExists ? 'Component found in registry' : 'Component not found in registry',
      registryPath: registryFile.path,
      newComponents: newComponents.map(component => ({
        name: component.name,
        category: component.category,
        description: component.description,
        width: component.width,
        height: component.height
      }))
    });
  } catch (err) {
    console.error('Component check error:', err);
    res.status(500).json({ 
      error: 'Component check failed', 
      details: err.message 
    });
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

// --- New Combined Endpoint: Parse Figma and Check Components ---
app.post('/api/parse-and-check', async (req, res) => {
  const { fileKey, nodeId } = req.body;
  
  try {
    // Step 1: Parse Figma file
    console.log('Parsing Figma file...');
    const fileResponse = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: { 
        'X-Figma-Token': FIGMA_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    let nodeData;
    if (nodeId) {
      const nodeResponse = await axios.get(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`, {
        headers: { 
          'X-Figma-Token': FIGMA_TOKEN,
          'Content-Type': 'application/json'
        }
      });
      nodeData = nodeResponse.data.nodes[0].document;
    } else {
      nodeData = fileResponse.data.document;
    }

    const { atomicComponents, screens } = extractAllNestedComponents(nodeData);

    // Step 2: Check components in registry
    console.log('Checking components in registry...');
    console.log('GitLab Configuration:', {
      projectId: GITLAB_PROJECT_ID,
      tokenLength: GITLAB_TOKEN.length,
      tokenPrefix: GITLAB_TOKEN.substring(0, 4) + '...',
      tokenEnd: GITLAB_TOKEN.substring(GITLAB_TOKEN.length - 4),
      tokenFormat: GITLAB_TOKEN.startsWith('glpat-') ? 'glpat- format' : 'other format'
    });

    try {
      // First, get the repository tree with pagination
      let allFiles = [];
      let page = 1;
      let hasMore = true;
      
      const headers = { 
        'PRIVATE-TOKEN': GITLAB_TOKEN,
        'Content-Type': 'application/json'
      };
      
      while (hasMore) {
        const gitlabUrl = `https://gitlab.urbanclap.com/api/v4/projects/${GITLAB_PROJECT_ID}/repository/tree?recursive=true&per_page=100&page=${page}`;
        console.log(`Fetching page ${page} of repository tree...`);
        
        const gitlabResponse = await axios.get(gitlabUrl, { headers });
        
        if (gitlabResponse.data.length === 0) {
          hasMore = false;
        } else {
          allFiles = [...allFiles, ...gitlabResponse.data];
          page++;
        }
      }
      
      console.log(`Total files found: ${allFiles.length}`);
      console.log('All repository files:', allFiles.map(file => file.path));
      
      // Try different possible paths for the registry file
      const possibleRegistryPaths = [
        'packages/customer/src/registry.ts',
        'packages/src/customer/vdlComponents/registry.ts',
        'packages/src/registry.ts',
        'src/registry.ts'
      ];

      let registryFile = null;
      for (const path of possibleRegistryPaths) {
        registryFile = allFiles.find(file => file.path === path);
        if (registryFile) {
          console.log(`Found registry file at: ${path}`);
          break;
        }
      }

      if (!registryFile) {
        console.log('Registry file not found. Available paths:', allFiles.map(f => f.path));
        return res.json({ 
          success: true,
          message: 'Registry file not found in repository',
          availablePaths: allFiles.map(f => f.path),
          components: {
            existing: [],
            new: atomicComponents
          },
          screens: screens,
          fileInfo: {
            name: fileResponse.data.name,
            lastModified: fileResponse.data.lastModified,
            version: fileResponse.data.version
          }
        });
      }

      // Get registry content
      const registryUrl = `https://gitlab.urbanclap.com/api/v4/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(registryFile.path)}/raw`;
      console.log('Fetching registry content from:', registryUrl);
      
      const registryContentResponse = await axios.get(registryUrl, { headers });
      console.log('Registry content response status:', registryContentResponse.status);

      const registryContent = registryContentResponse.data;

      // Use OpenAI to compare components
      console.log('Using OpenAI to compare components...');
      const componentNames = atomicComponents.map(c => c.name);
      
      const openaiResponse = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `Analyze component names against registry content. Return JSON with:
            {
              "existing": [{"originalName": "ComponentName", "matchedName": "RegistryName"}],
              "new": ["ComponentName"]
            }
            
            Rules:
            1. Match variations (e.g., "BadgeStack" = "badge-stack" = "Badge Stack")
            2. Consider partial matches (e.g., "Badge" in "BadgeStack")
            3. Be conservative in matching`
          },
          {
            role: "user",
            content: `Registry:
${registryContent}

Components:
${JSON.stringify(componentNames, null, 2)}`
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1, // Lower temperature for more consistent results
        max_tokens: 500  // Limit token usage
      });

      const analysis = JSON.parse(openaiResponse.choices[0].message.content);
      console.log('OpenAI analysis:', analysis);

      // Separate components based on OpenAI analysis
      const existingComponents = atomicComponents.filter(component => 
        analysis.existing.some(e => e.originalName === component.name)
      );
      
      const newComponents = atomicComponents.filter(component => 
        analysis.new.some(n => n === component.name)
      );

      res.json({ 
        success: true,
        message: 'Components parsed and checked successfully',
        components: {
          existing: existingComponents,
          new: newComponents,
          analysis: analysis // Include the OpenAI analysis for reference
        },
        screens: screens,
        fileInfo: {
          name: fileResponse.data.name,
          lastModified: fileResponse.data.lastModified,
          version: fileResponse.data.version
        }
      });
    } catch (gitlabError) {
      console.error('GitLab API Error Details:', {
        url: gitlabError.config?.url,
        method: gitlabError.config?.method,
        headers: {
          ...gitlabError.config?.headers,
          'PRIVATE-TOKEN': gitlabError.config?.headers?.['PRIVATE-TOKEN']?.substring(0, 4) + '...' + gitlabError.config?.headers?.['PRIVATE-TOKEN']?.substring(gitlabError.config?.headers?.['PRIVATE-TOKEN']?.length - 4)
        },
        status: gitlabError.response?.status,
        statusText: gitlabError.response?.statusText,
        data: gitlabError.response?.data,
        message: gitlabError.message
      });

      // Return components without registry check
      return res.json({ 
        success: true,
        message: 'GitLab API access failed, returning all components as new',
        components: {
          existing: [],
          new: atomicComponents
        },
        screens: screens,
        fileInfo: {
          name: fileResponse.data.name,
          lastModified: fileResponse.data.lastModified,
          version: fileResponse.data.version
        },
        gitlabError: {
          status: gitlabError.response?.status,
          message: gitlabError.response?.data?.message || gitlabError.message,
          details: gitlabError.response?.data
        }
      });
    }
  } catch (err) {
    console.error('Parse and check error:', err);
    res.status(500).json({ 
      error: 'Parse and check failed', 
      details: err.message 
    });
  }
});

// --- Test GitLab Configuration ---
app.get('/api/test-gitlab', async (req, res) => {
  try {
    // Check if environment variables are set
    if (!GITLAB_TOKEN || !GITLAB_PROJECT_ID) {
      return res.status(400).json({
        success: false,
        message: 'Missing GitLab configuration',
        config: {
          hasToken: !!GITLAB_TOKEN,
          hasProjectId: !!GITLAB_PROJECT_ID
        }
      });
    }

    // Test project access
    const projectResponse = await axios.get(
      `https://gitlab.urbanclap.com/api/v4/projects/${GITLAB_PROJECT_ID}`,
      {
        headers: { 
          'PRIVATE-TOKEN': GITLAB_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    // Test repository access
    const treeResponse = await axios.get(
      `https://gitlab.urbanclap.com/api/v4/projects/${GITLAB_PROJECT_ID}/repository/tree?recursive=true`,
      {
        headers: { 
          'PRIVATE-TOKEN': GITLAB_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    // Check for registry file
    const registryFile = treeResponse.data.find(file => 
      file.path === 'packages/src/customer/vdlComponents/registry.ts'
    );

    res.json({
      success: true,
      message: 'GitLab configuration verified successfully',
      project: {
        id: GITLAB_PROJECT_ID,
        name: projectResponse.data.name,
        path: projectResponse.data.path_with_namespace,
        visibility: projectResponse.data.visibility
      },
      repository: {
        hasAccess: true,
        registryFile: registryFile ? {
          path: registryFile.path,
          type: registryFile.type
        } : null
      }
    });
  } catch (error) {
    console.error('GitLab test error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });

    res.status(500).json({
      success: false,
      message: 'GitLab configuration test failed',
      error: {
        status: error.response?.status,
        message: error.response?.data?.message || error.message,
        details: error.response?.data
      }
    });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
