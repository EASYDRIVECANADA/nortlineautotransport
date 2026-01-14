import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { MessageCircle, X, Send, Minimize2 } from 'lucide-react';
import milesAvatar from '../../images/AIProfile.jpg';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot';
  timestamp: Date;
}

export default function ChatBot() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const botName = 'Miles';
  const botTagline = 'AI Transport Assistant';
  const botAvatarUrl = import.meta.env?.VITE_BOT_AVATAR_URL || milesAvatar;
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      text: "Hi, I'm Miles. I can help you book vehicle transportation in seconds.",
      sender: 'bot',
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const webhookUrl = import.meta.env?.VITE_CHAT_WEBHOOK || '/api/chatbot';
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

    const bulletRegex = /(?:^|[\n\r])\s*[-•–]\s+/g;
    const matches = text.match(bulletRegex);
    if (matches && matches.length >= 3) {
      const items = text
        .replace(/^[\s\S]*?(?:-|•|–)\s+/, '')
        .split(/\n\s*(?:-|•|–)\s+|\s+-\s+/)
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

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const getTypingDelayMs = (text: string) => {
    const len = String(text ?? '').trim().length;
    const base = 550;
    const perChar = Math.min(1400, Math.floor(len * 10));
    const jitter = Math.floor(Math.random() * 250);
    return base + perChar + jitter;
  };

  const normalizeQuestion = (s: string): string =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const getMilesVehiclePolicyResponse = (userInput: string): string | null => {
    const input = normalizeQuestion(userInput);
    if (!input) return null;

    const mentionsVehicleCondition =
      /(vehicle condition|runs and drives|run and drive|does not run|doesnt run|does not drive|doesnt drive|non running|not running|not drivable)/.test(
        input
      );
    const mentionsLoadingFee = /(loading fee|50 fee|50 loading|extra 50|additional 50|loaded with assistance)/.test(input);
    const mentionsDryRun = /(dry run|driver arrives|not present|not at pickup|cannot be moved|can t be moved|cant be moved|cannot be started|can t be started|cant be started)/.test(
      input
    );
    const wantsReminderTone = /(surprise|ahead of time|no surprises|remind|reminder|flag this)/.test(input);

    if (!(mentionsVehicleCondition || mentionsLoadingFee || mentionsDryRun)) return null;

    if (wantsReminderTone) {
      return [
        "I want to flag this ahead of time so there are no surprises.",
        "",
        "Please make sure the vehicle is at the pickup location and can run and drive. If it does not run but can still be loaded, there is a 50 loading fee.",
        "",
        "If the vehicle is not available or cannot be moved when the driver arrives, the full transport fee applies as a dry run.",
        "",
        "Let me know if you would like to double check anything before proceeding.",
      ].join('\n');
    }

    return [
      "I just want to confirm that the vehicle must be running and available at the pickup location.",
      "",
      "If the vehicle does not run or drive but can still be loaded, an additional 50 loading fee applies.",
      "",
      "If the driver arrives and the vehicle cannot be moved or is not at the pickup address, the order is treated as a dry run and the full transportation cost applies.",
    ].join('\n');
  };

  const getMilesTechSupportResponse = (userInput: string): string | null => {
    const input = normalizeQuestion(userInput);
    if (!input) return null;

    const mentionsNotWorking = /(not working|isnt working|isn t working|glitch|glitching|bug|broken|issue|problem|error)/.test(input);
    const mentionsPayment = /(payment|pay|checkout|stripe|card|declined|failed)/.test(input);
    const mentionsUpload = /(upload|document|file|pdf|jpg|png)/.test(input);
    const mentionsPricing = /(pricing|price|quote|cost)/.test(input);
    const mentionsLoadFreeze = /(won t load|wont load|not load|loading forever|freeze|freezing|stuck|blank page|page won t load)/.test(input);

    const mentionsReleaseForm = /(release form|eblock|work order|bill of lading)/.test(input);
    const mentionsManualEntry = /(manual entry|manual form|enter manually|fill out manually)/.test(input);

    if (mentionsReleaseForm && mentionsUpload && /(not working|failed|fail|error|not going through|doesn t work|doesnt work)/.test(input)) {
      return [
        "Thanks for letting me know. I see how that could interrupt the flow, but we can still move this forward without any problem.",
        "",
        "If the release form upload is not working, please use the manual entry option and enter the vehicle and pickup or delivery details directly.",
        "",
        "This will allow you to continue booking without delays.",
      ].join('\n');
    }

    if (mentionsManualEntry && /(unclear|confusing|don t understand|dont understand|help|where|how)/.test(input)) {
      return [
        "If it helps, I can walk you through the manual entry step by step.",
        "",
        "Just let me know what you are seeing on your screen.",
      ].join('\n');
    }

    if (mentionsManualEntry && /(delay|delays|take longer|slow)/.test(input)) {
      return [
        "Using manual entry will not delay your booking.",
        "Once payment is completed, your transportation request can still be scheduled as normal.",
      ].join('\n');
    }

    if ((mentionsManualEntry || mentionsReleaseForm) && /(prefer not|don t want|dont want|not continue|stop|cancel)/.test(input)) {
      return [
        "That’s completely fine. I can either create a support ticket for you or connect you with a live agent to take a closer look.",
        "",
        "Just let me know how you would like to proceed.",
      ].join('\n');
    }

    if (mentionsPayment && /(not going through|doesn t work|doesnt work|failed|declined|error)/.test(input)) {
      return [
        "I’m sorry about that — payment issues can be frustrating.",
        "Before we escalate, please double-check:",
        "• Your payment details",
        "• That the page fully refreshed",
        "• That you’re not using a blocked pop-up or VPN",
        "",
        "If it’s still not working, please upload a screenshot or tell me exactly what error message you’re seeing.",
      ].join('\n');
    }

    if (mentionsPricing && /(not showing|not loading|doesn t show|doesnt show|missing|blank|stuck)/.test(input)) {
      return [
        "Thanks for flagging this. Pricing should load instantly.",
        "Please let me know:",
        "• The destination you selected",
        "• Whether you uploaded a release form",
        "• What you see on screen",
        "",
        "A screenshot will help us resolve this quickly.",
      ].join('\n');
    }

    if (mentionsUpload && /(error|failed|fail|not going through|doesn t work|doesnt work)/.test(input)) {
      return [
        "It looks like the document upload may not have gone through.",
        "Please make sure the file is:",
        "• PDF, JPG, or PNG",
        "• Under the maximum file size",
        "",
        "If it still fails, feel free to upload a screenshot or tell me what error you’re seeing.",
      ].join('\n');
    }

    if (mentionsLoadFreeze) {
      return [
        "Thanks for the heads-up. If you’re able to, please let me know:",
        "• What page you’re on",
        "• What you were trying to do",
        "• What device or browser you’re using",
        "",
        "You can also upload a screenshot here if that’s easier.",
      ].join('\n');
    }

    if (mentionsNotWorking) {
      return [
        "Thanks for letting me know — I’m sorry about that.",
        "Let’s take a quick look so we can fix it.",
        "",
        "Can you briefly describe what’s not working or share a screenshot of the issue?",
      ].join('\n');
    }

    if (/(escalate|live agent|human|support ticket|ticket)/.test(input)) {
      return [
        "Thanks for walking through that with me.",
        "I’m going to escalate this so we can take care of it properly.",
        "",
        "Would you like me to:",
        "• Connect you with a live agent, or",
        "• Create a support ticket and follow up by email?",
      ].join('\n');
    }

    if (/(connect.*live agent|live agent now|agent now)/.test(input)) {
      return [
        "I’m connecting you to a live support agent now.",
        "They’ll be able to take a closer look and assist you directly.",
        "",
        "Please stay here for a moment.",
      ].join('\n');
    }

    if (/(create.*ticket|support ticket|open.*ticket)/.test(input)) {
      return [
        "I’ve created a support ticket for your issue.",
        "Our team will review it and follow up shortly.",
        "",
        "You’ll receive updates by email once it’s been reviewed.",
      ].join('\n');
    }

    if (/(no agent|unavailable|no one available|no live agent)/.test(input)) {
      return [
        "Our team is currently unavailable, but your request has been logged.",
        "We’ll follow up as soon as possible.",
        "",
        "If it’s urgent, you can also contact us directly at:",
        "📞 613-915-5199",
        "📧 contact@northlineautotransport.com",
      ].join('\n');
    }

    return null;
  };

  const getMilesFaqResponse = (userInput: string): string | null => {
    const input = normalizeQuestion(userInput);
    if (!input) return null;

    if (/(get a quote|getting a quote|quote now|how.*get.*quote|how.*quote)/.test(input)) {
      return [
        "To get a quote, just follow these quick steps:",
        "",
        "1) Choose Pickup (one-way) or Delivery (one-way)",
        "2) Select your Route / Service Area (destination)",
        "3) Upload your release form (or use manual entry)",
        "",
        "You’ll see instant pricing, and you can complete booking online in minutes.",
      ].join('\n');
    }

    if (/(route|routes|service area|service areas|destination|destinations|cities|city|where do you go|where do you deliver|where do you pick up)/.test(input)) {
      return [
        "We offer one-way vehicle pickup or delivery from Ottawa, with dealer-focused routes across Ontario and Quebec.",
        "",
        "To see available routes, use the Route / Service Area dropdown in the quote form.",
        "If you don’t see the city you need, tell me the pickup and drop-off locations and I’ll help you with the next best option.",
      ].join('\n');
    }

    if (/(pickup|pick up)/.test(input) && !/(pick up address|pickup address|pickup location|where is pickup address)/.test(input)) {
      return [
        "Pickup (one-way) means we pick up the vehicle from the selected Route / Service Area and bring it to Ottawa.",
        "",
        "Delivery (one-way) means we pick up in Ottawa and deliver to the selected Route / Service Area.",
        "",
        "If you tell me the city and whether you want pickup or delivery, I can guide you through the quote form.",
      ].join('\n');
    }

    if (/(delivery|deliver)/.test(input) && !/(delivery address|drop off|dropoff|drop off address|dropoff address)/.test(input)) {
      return [
        "Delivery (one-way) means we pick up in Ottawa and deliver to the selected Route / Service Area.",
        "",
        "Pickup (one-way) means we pick up the vehicle from the selected Route / Service Area and bring it to Ottawa.",
        "",
        "If you share the city you’re delivering to, I can help you get instant pricing.",
      ].join('\n');
    }

    if (/(vehicle shipping|car shipping|auto transport|vehicle transport|shipping a car|ship a car|transport my car|move my car)/.test(input)) {
      return [
        "We provide professional, insured vehicle transportation for dealerships and automotive partners across Ontario and Quebec.",
        "",
        "Booking is online with instant pricing, and transport is scheduled after payment confirmation.",
        "",
        "If you tell me pickup vs delivery and the Route / Service Area, I can help you get a quote right away.",
      ].join('\n');
    }

    if (/(how much|cost|price|pricing|quote)/.test(input)) {
      return [
        "Pricing depends on the destination and whether it’s a one-way pickup or delivery from Ottawa.",
        "I can show you instant pricing — just upload a release form or select your destination.",
      ].join('\n');
    }

    if (/(one way|oneway|round trip|roundtrip)/.test(input) && /(price|pricing|cost)/.test(input)) {
      return [
        "All pricing is one-way only, either pickup or delivery from Ottawa.",
        "If you need both, you can book each leg separately.",
      ].join('\n');
    }

    if (/(tax included|include tax|taxes included|hst|gst|qst)/.test(input)) {
      return "Prices are shown before tax. Applicable tax is added at checkout before payment.";
    }

    if (/(how does this work|how it works|how do i book|how to book)/.test(input)) {
      return [
        "It’s simple. Get instant pricing, upload your release form, complete payment, and we schedule your transport.",
        "Most orders can be completed in as little as 30 seconds.",
      ].join('\n');
    }

    if (/(need to call|phone call|call someone)/.test(input)) {
      return "No calls are required. Everything is done online for faster scheduling.";
    }

    if (/(when is my vehicle scheduled|when will it be scheduled|scheduled after|schedule my vehicle)/.test(input)) {
      return [
        "Your vehicle is scheduled after full payment is received.",
        "This allows us to move quickly and avoid delays.",
      ].join('\n');
    }

    if (/(pay later|invoice|invoiced|net terms|bill me later)/.test(input)) {
      return [
        "We require full payment at the time of booking.",
        "This ensures immediate scheduling and keeps the process fast and efficient.",
      ].join('\n');
    }

    if (/(why.*upfront|require payment upfront|prepay|prepayment)/.test(input)) {
      return "Prepayment allows us to schedule transport right away, avoid billing delays, and keep pricing competitive for dealers.";
    }

    if (/(payment methods|what payment|credit card|debit|stripe)/.test(input)) {
      return "We accept secure online payments through our checkout system at booking.";
    }

    if (/(how long|how long does.*take|transportation time|timeline|delivery time)/.test(input)) {
      return [
        "Most transports are completed within 3–8 business days.",
        "Some high-density routes, like Montreal, may be as fast as 1–2 business days.",
      ].join('\n');
    }

    if (/(guarantee|guaranteed).*date|guarantee a delivery date/.test(input)) {
      return "Timelines are estimates and can vary due to routing, weather, or scheduling, but we prioritize efficient turnaround on all routes.";
    }

    if (/(insured|insurance|coverage)/.test(input)) {
      return "Yes. All vehicles are transported by a professional carrier and covered by commercial insurance up to $2,000,000.";
    }

    if (/(who.*transport|who drives|carrier|who actually transports)/.test(input)) {
      return "Transportation is fulfilled by North Line Auto Transport’s professional carrier team.";
    }

    if (/(dealers only|dealer only|for dealers|dealership)/.test(input) && /(only|open|anyone)/.test(input)) {
      return "We primarily work with dealerships and automotive partners, but our platform is open to anyone who needs vehicle transportation.";
    }

    if (/(volume pricing|bulk|fleet|many cars|multiple vehicles)/.test(input)) {
      return [
        "Volume opportunities may be available depending on routing and frequency.",
        "You can contact our team directly for dealer-specific arrangements.",
      ].join('\n');
    }

    if (/(what documents|documents.*need|release form|work order)/.test(input)) {
      return [
        "A vehicle release form or work order is typically required.",
        "You can upload documents directly during booking.",
      ].join('\n');
    }

    if (/(upload.*later|documents.*later)/.test(input)) {
      return "It’s best to upload documents during booking so we can schedule your transport without delays.";
    }

    if (/(need help|still have questions|contact|support|human)/.test(input)) {
      return [
        "I can help with pricing and booking, or you can contact our team directly at",
        "📞 613-915-5199",
        "📧 contact@northlineautotransport.com",
      ].join('\n');
    }

    return null;
  };

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

    const sentAt = Date.now();

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputValue,
      sender: 'user',
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsBotTyping(true);

    const scripted =
      getMilesVehiclePolicyResponse(userMessage.text) ||
      getMilesTechSupportResponse(userMessage.text) ||
      getMilesFaqResponse(userMessage.text);
    if (scripted) {
      const delay = getTypingDelayMs(scripted);
      await sleep(delay);
      const botResponse: Message = {
        id: (Date.now() + 1).toString(),
        text: scripted,
        sender: 'bot',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, botResponse]);
      setIsBotTyping(false);
      return;
    }

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

      const minTotal = getTypingDelayMs(botText);
      const elapsed = Date.now() - sentAt;
      if (elapsed < minTotal) {
        await sleep(minTotal - elapsed);
      }

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
                  {botAvatarUrl && !avatarFailed ? (
                    <img
                      src={botAvatarUrl}
                      alt={botName}
                      className="w-full h-full object-cover"
                      onError={() => setAvatarFailed(true)}
                    />
                  ) : (
                    <span aria-hidden>{botName.slice(0, 1).toUpperCase()}</span>
                  )}
                </div>
                <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-400 rounded-full border-2 border-slate-900"></div>
              </div>
              <div>
                <h3 className="text-white font-semibold text-lg">{botName}</h3>
                <p className="text-cyan-400 text-xs">{botTagline}</p>
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
                    className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'} items-end gap-2 animate-fadeIn`}
                  >
                    {message.sender === 'bot' && (
                      <div className="flex-shrink-0">
                        <div className="w-8 h-8 bg-gradient-to-br from-cyan-400 to-cyan-600 rounded-full flex items-center justify-center font-bold text-white text-sm shadow-lg overflow-hidden">
                          {botAvatarUrl && !avatarFailed ? (
                            <img
                              src={botAvatarUrl}
                              alt={botName}
                              className="w-full h-full object-cover"
                              onError={() => setAvatarFailed(true)}
                            />
                          ) : (
                            <span aria-hidden>{botName.slice(0, 1).toUpperCase()}</span>
                          )}
                        </div>
                      </div>
                    )}
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-lg ${
                        message.sender === 'user'
                          ? 'bg-gradient-to-br from-cyan-500 to-cyan-600 text-white rounded-br-md'
                          : 'bg-slate-700 text-gray-100 rounded-bl-md border border-slate-600'
                      }`}
                    >
                      {message.sender === 'bot' && (
                        <div className="text-xs font-semibold text-cyan-300 mb-1">{botName}</div>
                      )}
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
                  <div className="flex justify-start items-end gap-2 animate-fadeIn">
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 bg-gradient-to-br from-cyan-400 to-cyan-600 rounded-full flex items-center justify-center font-bold text-white text-sm shadow-lg overflow-hidden">
                        {botAvatarUrl && !avatarFailed ? (
                          <img
                            src={botAvatarUrl}
                            alt={botName}
                            className="w-full h-full object-cover"
                            onError={() => setAvatarFailed(true)}
                          />
                        ) : (
                          <span aria-hidden>{botName.slice(0, 1).toUpperCase()}</span>
                        )}
                      </div>
                    </div>
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
