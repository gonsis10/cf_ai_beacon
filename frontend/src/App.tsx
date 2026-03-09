import { useState, useEffect, useRef } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ChatSession {
  id: string
  preview: string
  timestamp: number
}

interface Ticket {
  id: string
  sessionId: string
  type: 'escalation' | 'refund' | 'inappropriate'
  reason: string
  orderId?: string
  summary: string
  timestamp: number
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [isClosed, setIsClosed] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const fetchTickets = async () => {
    const res = await fetch('/api/escalations')
    const data = await res.json()
    if (data.tickets) {
      setTickets(data.tickets)
    }
  }

  useEffect(() => {
    const stored = localStorage.getItem('beacon_sessions')
    const savedSessions: ChatSession[] = stored ? JSON.parse(stored) : []
    setSessions(savedSessions)

    fetchTickets()

    const currentId = localStorage.getItem('beacon_session_id')
    if (currentId) {
      setSessionId(currentId)
      loadHistory(currentId)
    } else {
      createSession()
    }
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const saveSessions = (updated: ChatSession[]) => {
    setSessions(updated)
    localStorage.setItem('beacon_sessions', JSON.stringify(updated))
  }

  const createSession = async () => {
    const res = await fetch('/api/session', { method: 'POST' })
    const data = await res.json()
    setSessionId(data.sessionId)
    setMessages([])
    setIsClosed(false)
    localStorage.setItem('beacon_session_id', data.sessionId)

    const newChat: ChatSession = {
      id: data.sessionId,
      preview: 'New conversation',
      timestamp: Date.now(),
    }
    saveSessions([newChat, ...sessions])
  }

  const loadHistory = async (sid: string) => {
    const res = await fetch(`/api/history?sessionId=${sid}`)
    const data = await res.json()
    if (data.messages) {
      setMessages(data.messages)
    }
    setIsClosed(data.closed || false)
  }

  const switchSession = (sid: string) => {
    setSessionId(sid)
    localStorage.setItem('beacon_session_id', sid)
    loadHistory(sid)
  }

  const updateSessionPreview = (sid: string, preview: string) => {
    const updated = sessions.map(s =>
      s.id === sid ? { ...s, preview: preview.slice(0, 40), timestamp: Date.now() } : s
    )
    saveSessions(updated)
  }

  const deleteSession = async (sid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`/api/session?sessionId=${sid}`, { method: 'DELETE' })
    const updated = sessions.filter(s => s.id !== sid)
    saveSessions(updated)
    if (sessionId === sid) {
      if (updated.length > 0) {
        switchSession(updated[0].id)
      } else {
        createSession()
      }
    }
  }

  const deleteTicket = async (ticketId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`/api/ticket?ticketId=${ticketId}`, { method: 'DELETE' })
    setTickets(tickets.filter(t => t.id !== ticketId))
  }

  const sendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!input.trim() || !sessionId || isLoading) return

    const userMessage = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setIsLoading(true)

    if (messages.length === 0) {
      updateSessionPreview(sessionId, userMessage)
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: userMessage }),
      })
      const data = await res.json()
      if (data.response) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.response }])
      }
      if (data.ticket) {
        fetchTickets()
      }
      if (data.closed) {
        setIsClosed(true)
      }
    } catch (err) {
      console.error('Chat error:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="h-screen bg-neutral-900 flex">
      <div className="w-64 border-r border-neutral-800 flex flex-col">
        <div className="h-14 px-4 flex items-center border-b border-neutral-800">
          <h2 className="text-sm font-medium text-neutral-400">Tickets</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {tickets.map(ticket => (
            <div
              key={ticket.id}
              onClick={() => switchSession(ticket.sessionId)}
              className="group w-full text-left px-4 py-3 border-b border-neutral-800 hover:bg-neutral-800 cursor-pointer relative"
            >
              <p className={`text-sm truncate pr-6 ${
                ticket.type === 'inappropriate' ? 'text-orange-400' :
                ticket.type === 'refund' ? 'text-yellow-400' : 'text-red-400'
              }`}>
                {ticket.summary}
              </p>
              <p className="text-xs text-neutral-600 mt-1">
                {ticket.type} · {new Date(ticket.timestamp).toLocaleDateString()}
              </p>
              <button
                onClick={(e) => deleteTicket(ticket.id, e)}
                className="absolute right-2 top-3 text-neutral-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </div>
          ))}
          {tickets.length === 0 && (
            <p className="text-xs text-neutral-600 p-4">No tickets</p>
          )}
        </div>
      </div>

      <div className="w-64 border-r border-neutral-800 flex flex-col">
        <div className="h-14 px-4 flex items-center justify-between border-b border-neutral-800">
          <h2 className="text-sm font-medium text-neutral-400">Chats</h2>
          <button
            onClick={createSession}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.map(session => (
            <div
              key={session.id}
              onClick={() => switchSession(session.id)}
              className={`group w-full text-left px-4 py-3 border-b border-neutral-800 hover:bg-neutral-800 cursor-pointer relative ${
                session.id === sessionId ? 'bg-neutral-800' : ''
              }`}
            >
              <p className="text-sm text-neutral-300 truncate pr-6">{session.preview}</p>
              <p className="text-xs text-neutral-600 mt-1">
                {new Date(session.timestamp).toLocaleDateString()}
              </p>
              <button
                onClick={(e) => deleteSession(session.id, e)}
                className="absolute right-2 top-3 text-neutral-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="text-xs text-neutral-600 p-4">No chats yet</p>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="h-14 px-4 flex items-center border-b border-neutral-800">
          <span className="text-sm text-neutral-400">Striker Elite Support</span>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.length === 0 && (
            <p className="text-neutral-600 text-sm">How can we help you today?</p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={msg.role === 'user' ? 'text-right' : 'text-left'}>
              <span
                className={`inline-block px-3 py-2 rounded text-sm max-w-[70%] ${
                  msg.role === 'user'
                    ? 'bg-neutral-800 text-neutral-200'
                    : 'text-neutral-300'
                }`}
              >
                {msg.content}
              </span>
            </div>
          ))}
          {isLoading && (
            <p className="text-neutral-500 text-sm">...</p>
          )}
          <div ref={messagesEndRef} />
        </div>

        {isClosed ? (
          <div className="p-4 border-t border-neutral-800 text-center">
            <p className="text-sm text-neutral-500">This conversation is closed. A ticket has been raised.</p>
          </div>
        ) : (
          <form onSubmit={sendMessage} className="p-4 border-t border-neutral-800">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Message..."
                disabled={isLoading}
                className="flex-1 px-3 py-2 bg-transparent border border-neutral-700 rounded text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500"
              />
              <button
                type="submit"
                disabled={isLoading || !input.trim()}
                className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
              >
                Send
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export default App
