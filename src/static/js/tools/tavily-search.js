import { Logger } from '../utils/logger.js';

/**
 * Represents a tool for performing web searches using the Tavily API.
 */
export class TavilySearchTool {
    constructor() {
        this.baseUrl = 'https://api.tavily.com/search';
    }

    /**
     * Gets the API key from localStorage or uses the default fallback.
     * @returns {string} The Tavily API key
     */
    getApiKey() {
        // Try to get the API key from localStorage first
        const storedApiKey = localStorage.getItem('tavily_api_key');
        if (storedApiKey && storedApiKey.trim() !== '') {
            return storedApiKey;
        }
        // Return an empty string if not found - the caller should handle this case
        return '';
    }

    /**
     * Sets the API key in localStorage.
     * @param {string} apiKey - The Tavily API key to store
     */
    setApiKey(apiKey) {
        if (apiKey && apiKey.trim() !== '') {
            localStorage.setItem('tavily_api_key', apiKey.trim());
        } else {
            // Remove the key from localStorage if empty
            localStorage.removeItem('tavily_api_key');
        }
    }

    /**
     * Returns the tool declaration for the Gemini API.
     */
    getDeclaration() {
        return [{
            name: "tavily_search",
            description: "Search the web for current information on any topic using Tavily search engine",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The search query to look up"
                    },
                    search_depth: {
                        type: "string",
                        description: "Search depth: 'basic' for quick results, 'advanced' for more thorough search",
                        enum: ["basic", "advanced"]
                    },
                    max_results: {
                        type: "number",
                        description: "Maximum number of results to return (1-10, default 5)"
                    }
                },
                required: ["query"]
            }
        }];
    }

    /**
     * Executes the Tavily search tool.
     *
     * @param {Object} args - The arguments for the tool.
     * @param {string} args.query - The search query.
     * @param {string} [args.search_depth='basic'] - The search depth.
     * @param {number} [args.max_results=5] - Maximum number of results.
     * @returns {Promise<Object>} A promise that resolves with the search results.
     */
    async execute(args) {
        try {
            Logger.info('Executing Tavily Search Tool', args);

            const {
                query,
                search_depth = 'basic',
                max_results = 5
            } = args;

            // Get the API key
            const apiKey = this.getApiKey();
            if (!apiKey) {
                throw new Error('Tavily API key not found. Please enter your Tavily API key in the settings.');
            }

            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    api_key: apiKey,
                    query,
                    search_depth,
                    max_results: Math.min(Math.max(1, max_results), 10), // 限制在1-10之间
                    include_answer: true,       // 返回AI总结答案
                    include_raw_content: false  // 不返回原始HTML，减少数据量
                })
            });

            if (!response.ok) {
                throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            // 整理返回结果
            return {
                query,
                answer: data.answer || null,  // Tavily的AI总结
                results: data.results.map(r => ({
                    title: r.title,
                    url: r.url,
                    content: r.content,
                    score: r.score         // 相关性分数
                })),
                response_time: data.response_time
            };

        } catch (error) {
            Logger.error('Tavily Search Tool failed', error);
            throw error;
        }
    }
}