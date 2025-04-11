require('dotenv').config();
const axios = require('axios');

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const FILE_KEY = 'v6KD7JHlUIbwwtpAzISCNc';

async function testFigmaToken() {
    try {
        console.log('Testing Figma API with token...');
        const response = await axios.get(`https://api.figma.com/v1/files/${FILE_KEY}`, {
            headers: { 
                'X-Figma-Token': FIGMA_TOKEN,
                'Content-Type': 'application/json'
            }
        });
        console.log('Success! File data:', response.data);
    } catch (error) {
        console.error('Error details:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });
    }
}

testFigmaToken(); 