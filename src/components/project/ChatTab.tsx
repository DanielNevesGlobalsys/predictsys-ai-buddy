import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, User, Send, Loader2, Sparkles, Trash2 } from "lucide-react";

interface Message {
  id: string;
  sender_type: "user" | "assistant";
  message_text: string;
  created_at: string;
}

interface ChatTabProps {
  projectId: string;
  projectName: string;
}

const suggestedQuestions = [
  "Qual é o melhor modelo treinado?",
  "Quais são as variáveis mais importantes?",
  "Resuma este projeto para apresentar ao diretor",
  "Qual a performance do modelo?",
];

const ChatTab = ({ projectId, projectName }: ChatTabProps) => {
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadChatHistory();
  }, [projectId]);

  useEffect(() => {
    // Scroll to bottom when messages change
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const loadChatHistory = async () => {
    setIsLoadingHistory(true);
    const { data, error } = await supabase
      .from("project_chat_messages")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error loading chat history:", error);
    } else {
      setMessages((data || []).map((m) => ({
        ...m,
        sender_type: m.sender_type as "user" | "assistant",
      })));
    }
    setIsLoadingHistory(false);
  };

  const sendMessage = async (messageText?: string) => {
    const text = messageText || inputValue.trim();
    if (!text || isLoading) return;

    setInputValue("");
    setIsLoading(true);

    // Optimistically add user message
    const tempUserMessage: Message = {
      id: `temp-${Date.now()}`,
      sender_type: "user",
      message_text: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMessage]);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/project-chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({
            projectId,
            message: text,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Erro ao enviar mensagem");
      }

      // Add assistant message
      const assistantMessage: Message = {
        id: result.messageId || `assistant-${Date.now()}`,
        sender_type: "assistant",
        message_text: result.reply,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

    } catch (error) {
      console.error("Chat error:", error);
      toast({
        title: "Erro ao enviar mensagem",
        description: error instanceof Error ? error.message : "Tente novamente",
        variant: "destructive",
      });
      // Remove optimistic message on error
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMessage.id));
    } finally {
      setIsLoading(false);
    }
  };

  const clearHistory = async () => {
    const { error } = await supabase
      .from("project_chat_messages")
      .delete()
      .eq("project_id", projectId);

    if (error) {
      toast({
        title: "Erro ao limpar histórico",
        description: error.message,
        variant: "destructive",
      });
    } else {
      setMessages([]);
      toast({
        title: "Histórico limpo",
        description: "Todas as mensagens foram removidas.",
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const formatMessage = (text: string) => {
    // Simple markdown-like formatting
    return text
      .split("\n")
      .map((line, i) => {
        // Bold text
        line = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        return (
          <span key={i} dangerouslySetInnerHTML={{ __html: line }} />
        );
      })
      .reduce((acc: React.ReactNode[], curr, i, arr) => {
        acc.push(curr);
        if (i < arr.length - 1) acc.push(<br key={`br-${i}`} />);
        return acc;
      }, []);
  };

  return (
    <div className="flex flex-col h-[600px]">
      {/* Header */}
      <Card className="bg-gradient-card shadow-card p-4 mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-primary rounded-xl flex items-center justify-center">
              <Bot className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h3 className="font-semibold">Assistente IA</h3>
              <p className="text-sm text-muted-foreground">
                Tire dúvidas sobre o projeto {projectName}
              </p>
            </div>
          </div>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearHistory}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Limpar
            </Button>
          )}
        </div>
      </Card>

      {/* Messages area */}
      <Card className="flex-1 bg-gradient-card shadow-card overflow-hidden">
        <ScrollArea className="h-full p-4" ref={scrollRef}>
          {isLoadingHistory ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-6">
              <Sparkles className="w-12 h-12 text-primary mb-4" />
              <h4 className="font-semibold text-lg mb-2">
                Olá! Como posso ajudar?
              </h4>
              <p className="text-muted-foreground mb-6 max-w-md">
                Sou o assistente IA deste projeto. Posso responder perguntas sobre
                os dados, modelos treinados, métricas e muito mais.
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                {suggestedQuestions.map((question, i) => (
                  <Button
                    key={i}
                    variant="outline"
                    size="sm"
                    onClick={() => sendMessage(question)}
                    className="text-xs"
                  >
                    {question}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex gap-3 ${
                    msg.sender_type === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  {msg.sender_type === "assistant" && (
                    <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Bot className="w-4 h-4 text-primary" />
                    </div>
                  )}
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                      msg.sender_type === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    <div className="text-sm whitespace-pre-wrap">
                      {formatMessage(msg.message_text)}
                    </div>
                  </div>
                  {msg.sender_type === "user" && (
                    <div className="w-8 h-8 bg-secondary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-secondary" />
                    </div>
                  )}
                </div>
              ))}
              {isLoading && (
                <div className="flex gap-3 justify-start">
                  <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Bot className="w-4 h-4 text-primary" />
                  </div>
                  <div className="bg-muted rounded-2xl px-4 py-3">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </Card>

      {/* Input area */}
      <Card className="bg-gradient-card shadow-card p-4 mt-4">
        <div className="flex gap-3">
          <Textarea
            placeholder="Digite sua pergunta..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="min-h-[50px] max-h-[120px] resize-none"
            disabled={isLoading}
          />
          <Button
            onClick={() => sendMessage()}
            disabled={!inputValue.trim() || isLoading}
            className="px-4"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Pressione Enter para enviar ou Shift+Enter para nova linha
        </p>
      </Card>
    </div>
  );
};

export default ChatTab;
