import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { adminClient } from '@/lib/db'

const API_KEY = process.env.AGENT_API_KEY || 'super-secret-agent-key'

// Map API key to user_id (conference demo — single tenant)
const USER_ID = '2824a69b-4fa4-4ce9-8b5b-35c67a64823f'

function createServer() {
  const server = new McpServer({
    name: 'giftmaster',
    version: '1.0.0',
  })

  // --- list_persons ---
  server.tool(
    'list_persons',
    'List all people the user is tracking',
    {},
    async () => {
      const { data } = await adminClient()
        .from('persons')
        .select('id, name, created_at')
        .eq('user_id', USER_ID)
        .order('created_at', { ascending: false })
      return { content: [{ type: 'text', text: JSON.stringify(data ?? [], null, 2) }] }
    }
  )

  // --- add_person_note ---
  server.tool(
    'add_person_note',
    'Save a note or fact about a person (likes, dislikes, habits, events, preferences)',
    {
      person_id: z.string().uuid().describe('The UUID of the person'),
      content: z.string().min(1).describe('The note content to save'),
    },
    async ({ person_id, content }) => {
      const { data, error } = await adminClient()
        .from('person_notes')
        .insert({ person_id, user_id: USER_ID, content })
        .select()
        .single()
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }
      return { content: [{ type: 'text', text: `Note saved: "${content}" (id: ${data.id})` }] }
    }
  )

  // --- get_person_context ---
  server.tool(
    'get_person_context',
    'Get all notes and recent cards for a person — use this to understand them before making suggestions',
    {
      person_id: z.string().uuid().describe('The UUID of the person'),
    },
    async ({ person_id }) => {
      const db = adminClient()

      const [personRes, notesRes, cardsRes] = await Promise.all([
        db.from('persons').select('id, name').eq('id', person_id).eq('user_id', USER_ID).single(),
        db.from('person_notes').select('id, content, created_at').eq('person_id', person_id).eq('user_id', USER_ID).order('created_at', { ascending: false }).limit(50),
        db.from('chat_messages').select('id, type, title, content, status, created_at').eq('person_id', person_id).eq('user_id', USER_ID).order('created_at', { ascending: false }).limit(20),
      ])

      if (!personRes.data) {
        return { content: [{ type: 'text', text: 'Person not found' }], isError: true }
      }

      const context = {
        person: personRes.data,
        notes: notesRes.data ?? [],
        recent_cards: cardsRes.data ?? [],
      }
      return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] }
    }
  )

  // --- push_card ---
  server.tool(
    'push_card',
    'Push a suggestion card (gift idea, trip idea, check-in reminder, or gesture) to a person\'s chat',
    {
      person_id: z.string().uuid().describe('The UUID of the person'),
      title: z.string().min(1).describe('Short card title (5-8 words)'),
      content: z.string().min(1).describe('Warm, actionable suggestion (2-3 sentences)'),
    },
    async ({ person_id, title, content }) => {
      const { data, error } = await adminClient()
        .from('chat_messages')
        .insert({
          person_id,
          user_id: USER_ID,
          type: 'suggestion',
          title,
          content,
          status: 'pending',
        })
        .select()
        .single()
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }
      return { content: [{ type: 'text', text: `Card pushed: "${title}" (id: ${data.id})` }] }
    }
  )

  // --- update_card_status ---
  server.tool(
    'update_card_status',
    'Mark a suggestion card as done or rejected',
    {
      card_id: z.string().uuid().describe('UUID of the chat_message card'),
      status: z.enum(['done', 'rejected']).describe('New status'),
    },
    async ({ card_id, status }) => {
      const { data, error } = await adminClient()
        .from('chat_messages')
        .update({ status })
        .eq('id', card_id)
        .select()
        .single()
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }
      return { content: [{ type: 'text', text: `Card ${card_id} updated to: ${status}` }] }
    }
  )

  return server
}

function authenticate(request) {
  const key = request.headers.get('x-api-key')
  return key === API_KEY
}

async function handleMcpRequest(request) {
  const server = createServer()
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  await server.connect(transport)

  try {
    return await transport.handleRequest(request)
  } finally {
    await transport.close()
    await server.close()
  }
}

export async function POST(request) {
  if (!authenticate(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return handleMcpRequest(request)
}

export async function GET(request) {
  if (!authenticate(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return handleMcpRequest(request)
}

export async function DELETE() {
  return new Response(null, { status: 405 })
}
