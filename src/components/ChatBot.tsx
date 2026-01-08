import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { MessageCircle, X, Send, Minimize2 } from 'lucide-react';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot';
  timestamp: Date;
}

export default function ChatBot() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      text: "Hi there! I'm Navi, your virtual assistant. How can I help you today?",
      sender: 'bot',
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const webhookUrl = (import.meta as any).env?.VITE_CHAT_WEBHOOK || '/api/chatbot';
  const [isBotTyping, setIsBotTyping] = useState(false);
  const sessionIdRef = useRef<string>(
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const highlightPrices = (s: string): JSX.Element => {
    const parts = s.split(/(\$?\b\d{2,4}(?:\.\d{2})?)/);
    return (
      <>
        {parts.map((p, i) => (
          i % 2 === 1 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>
        ))}
      </>
    );
  };

  const formatBotText = (text: string): JSX.Element => {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        return (
          <ul className="list-disc pl-5 space-y-1">
            {data.map((item, idx) => (
              <li key={idx}>{String(item)}</li>
            ))}
          </ul>
        );
      }
      if (typeof data === 'object' && data) {
        return (
          <div className="space-y-1">
            {Object.entries(data as Record<string, unknown>).map(([k, v]) => (
              <div key={k}>
                <span className="font-semibold">{k}: </span>
                <span>{String(v)}</span>
              </div>
            ))}
          </div>
        );
      }
    } catch {
      // ignore
    }

    const bulletRegex = /(?:^|[\n\r])\s*[\-•–]\s+/g;
    const matches = text.match(bulletRegex);
    if (matches && matches.length >= 3) {
      const items = text
        .replace(/^[\s\S]*?(?:\-|•|–)\s+/, '')
        .split(/\n\s*(?:\-|•|–)\s+|\s+\-\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return (
        <ul className="list-disc pl-5 space-y-1">
          {items.map((item, i) => (
            <li key={i}>{highlightPrices(item)}</li>
          ))}
        </ul>
      );
    }

    const lines = text.split(/\n+/);
    return (
      <span>
        {lines.map((line, i) => (
          <span key={i}>
            {highlightPrices(line)}
            {i < lines.length - 1 && <br />}
          </span>
        ))}
      </span>
    );
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const getBotResponse = (userInput: string): string => {
    const input = userInput.toLowerCase();

    if (input.includes('hello') || input.includes('hi')) {
      return "Hey! Great to chat with you. What can I assist with?";
    } else if (input.includes('help')) {
      return "I'm here to help! Feel free to ask about our transportation services, pricing, or anything else.";
    } else if (input.includes('price') || input.includes('cost') || input.includes('quote')) {
      return "For a personalized quote, click 'Get a quote now' button or let me know the details of your shipment!";
    } else if (input.includes('support') || input.includes('contact')) {
      return "Our support team is available 24/7. We're always ready to assist you with any questions!";
    } else if (input.includes('track') || input.includes('status')) {
      return 'You can track your shipment in real-time through your account dashboard.';
    } else if (input.includes('thank')) {
      return "You're welcome! Is there anything else I can help you with?";
    } else if (input.includes('bye') || input.includes('goodbye')) {
      return 'Take care! Feel free to reach out anytime you need assistance!';
    }
    return "Thanks for your message! I'm here to help with transportation quotes, tracking, and support. What else can I do for you?";
  };

  const handleSend = async () => {
    if (inputValue.trim() === '') return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputValue,
      sender: 'user',
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsBotTyping(true);

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage.text,
          timestamp: userMessage.timestamp.toISOString(),
          sessionId: sessionIdRef.current,
        }),
      });

      if (!res.ok) {
        const bodyPreview = await res.text().catch(() => '');
        throw new Error(`Webhook HTTP ${res.status}: ${bodyPreview.slice(0, 250)}`);
      }

      let botText = '';
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        botText = data.message || data.reply || data.text || JSON.stringify(data);
      } else {
        botText = await res.text();
      }
      if (!botText) {
        botText = getBotResponse(userMessage.text);
      }

      const botResponse: Message = {
        id: (Date.now() + 1).toString(),
        text: botText,
        sender: 'bot',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, botResponse]);
    } catch (err) {
      console.error('Webhook error:', err);
      const fallback: Message = {
        id: (Date.now() + 1).toString(),
        text: getBotResponse(userMessage.text),
        sender: 'bot',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, fallback]);
    } finally {
      setIsBotTyping(false);
    }
  };

  const handleKeyPress = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 bg-cyan-500 hover:bg-cyan-600 text-white rounded-full p-4 shadow-2xl transition-all duration-300 hover:scale-110 z-50 group"
          aria-label="Open chat"
        >
          <MessageCircle className="w-7 h-7" />
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center animate-pulse">
            1
          </span>
        </button>
      )}

      {isOpen && (
        <div
          className={`fixed bottom-6 right-6 bg-slate-800 rounded-2xl shadow-2xl z-50 flex flex-col transition-all duration-300 ${
            isMinimized ? 'h-16' : 'h-[600px]'
          } w-[95vw] max-w-[420px]`}
        >
          <div className="bg-gradient-to-r from-slate-900 to-slate-800 p-4 rounded-t-2xl flex items-center justify-between border-b border-cyan-500/30">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-10 h-10 bg-gradient-to-br from-cyan-400 to-cyan-600 rounded-full flex items-center justify-center font-bold text-white text-lg shadow-lg overflow-hidden">
                  <img src="/navi.png" alt="Navi" className="w-full h-full object-cover" />
                </div>
                <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-400 rounded-full border-2 border-slate-900"></div>
              </div>
              <div>
                <h3 className="text-white font-semibold text-lg">Navi</h3>
                <p className="text-cyan-400 text-xs">Support Assistant</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsMinimized(!isMinimized)}
                className="text-gray-400 hover:text-cyan-400 transition-colors p-1.5 hover:bg-slate-700 rounded-lg"
                aria-label="Minimize chat"
              >
                <Minimize2 className="w-5 h-5" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="text-gray-400 hover:text-red-400 transition-colors p-1.5 hover:bg-slate-700 rounded-lg"
                aria-label="Close chat"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {!isMinimized && (
            <>
              <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-900/50">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'} animate-fadeIn`}
                  >
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-lg ${
                        message.sender === 'user'
                          ? 'bg-gradient-to-br from-cyan-500 to-cyan-600 text-white rounded-br-md'
                          : 'bg-slate-700 text-gray-100 rounded-bl-md border border-slate-600'
                      }`}
                    >
                      <div className="text-sm leading-relaxed">
                        {message.sender === 'bot' ? formatBotText(message.text) : message.text}
                      </div>
                      <p
                        className={`text-xs mt-1.5 ${
                          message.sender === 'user' ? 'text-cyan-100' : 'text-gray-400'
                        }`}
                      >
                        {message.timestamp.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                  </div>
                ))}
                {isBotTyping && (
                  <div className="flex justify-start animate-fadeIn">
                    <div className="max-w-[80%] rounded-2xl px-4 py-3 shadow-lg bg-slate-700 text-gray-100 rounded-bl-md border border-slate-600">
                      <div className="flex items-center gap-1">
                        <span className="typing-dot" />
                        <span className="typing-dot delay-1" />
                        <span className="typing-dot delay-2" />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-4 bg-slate-900 rounded-b-2xl border-t border-slate-700">
                <div className="flex gap-2 items-end">
                  <div className="flex-1 bg-slate-800 rounded-xl border border-slate-700 focus-within:border-cyan-500 transition-colors">
                    <textarea
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      onKeyPress={handleKeyPress}
                      placeholder="Type your message..."
                      rows={1}
                      className="w-full bg-transparent text-white placeholder-gray-400 px-4 py-3 focus:outline-none resize-none text-sm"
                      style={{ maxHeight: '100px' }}
                    />
                  </div>
                  <button
                    onClick={() => void handleSend()}
                    disabled={inputValue.trim() === ''}
                    className="bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-600 hover:to-cyan-700 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed text-white rounded-xl p-3 transition-all duration-200 hover:shadow-lg hover:shadow-cyan-500/50 disabled:shadow-none"
                    aria-label="Send message"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2 text-center">Powered by Easy Drive Canada</p>
              </div>
            </>
          )}
        </div>
      )}

      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
        }
        @keyframes blink {
          0% { opacity: 0.2; }
          20% { opacity: 1; }
          100% { opacity: 0.2; }
        }
        .typing-dot {
          width: 6px;
          height: 6px;
          background: #e2e8f0;
          border-radius: 9999px;
          display: inline-block;
          animation: blink 1.4s infinite both;
        }
        .typing-dot.delay-1 { animation-delay: 0.2s; }
        .typing-dot.delay-2 { animation-delay: 0.4s; }
      `}</style>
    </>
  );
}
