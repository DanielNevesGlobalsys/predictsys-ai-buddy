import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  ChevronLeft,
  Send,
  Loader2,
  User,
  Trash2,
  Sparkles,
} from "lucide-react";

interface Message {
  sender_type: "user" | "assistant";
  message_text: string;
  created_at: string;
}

const GlobalChat = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const suggestedQuestions = [
    t("globalChat.suggestedQuestions.q1"),
    t("globalChat.suggestedQuestions.q2"),
    t("globalChat.suggestedQuestions.q3"),
    t("globalChat.suggestedQuestions.q4"),
    t("globalChat.suggestedQuestions.q5"),
    t("globalChat.suggestedQuestions.q6"),
  ];

  useEffect(() => {
    loadChatHistory();
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const loadChatHistory = async () => {
    setIsLoadingHistory(true);
    try {
      const { data, error } = await supabase
        .from("global_chat_messages")
        .select("sender_type, message_text, created_at")
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages((data as Message[]) || []);
    } catch (error: any) {
      console.error("Error loading chat history:", error);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const sendMessage = async (text?: string) => {
    const messageText = text || inputValue.trim();
    if (!messageText || isLoading) return;

    setInputValue("");
    const userMessage: Message = {
      sender_type: "user",
      message_text: messageText,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const response = await supabase.functions.invoke("global-chat", {
        body: { message: messageText, language: i18n.language },
      });

      if (response.error || !response.data?.success) {
        throw new Error(response.data?.error || response.error?.message || "Erro ao enviar mensagem");
      }

      const assistantMessage: Message = {
        sender_type: "assistant",
        message_text: response.data.response,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error: any) {
      toast({
        title: t("globalChat.errorSending"),
        description: error.message,
        variant: "destructive",
      });
      // Remove optimistic user message on error
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  const clearHistory = async () => {
    try {
      const { error } = await supabase
        .from("global_chat_messages")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000"); // Delete all

      if (error) throw error;

      setMessages([]);
      toast({
        title: t("globalChat.historyCleared"),
        description: t("globalChat.allMessagesDeleted"),
      });
    } catch (error: any) {
      toast({
        title: t("globalChat.errorClearHistory"),
        description: error.message,
        variant: "destructive",
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
    return text.split("\n").map((line, index) => (
      <span key={index}>
        {line}
        {index < text.split("\n").length - 1 && <br />}
      </span>
    ));
  };

  return (
    <div className="min-h-screen bg-gradient-hero">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <img 
              src="/images/assistente-globalsys.png" 
              alt="Assistente virtual Globalsys"
              className="w-10 h-10 rounded-full object-cover"
            />
            <div>
              <h1 className="text-xl font-bold">{t("globalChat.title")}</h1>
              <p className="text-sm text-muted-foreground">{t("globalChat.subtitle")}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={clearHistory}>
            <Trash2 className="w-4 h-4 mr-2" />
            {t("globalChat.clear")}
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 max-w-4xl">
        <Card className="bg-gradient-card shadow-card flex flex-col h-[calc(100vh-180px)]">
          {/* Info banner */}
          <div className="p-4 border-b border-border/40 bg-primary/5">
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              {t("globalChat.infoBanner")}
            </p>
          </div>

          {/* Messages area */}
          <ScrollArea className="flex-1 p-4">
            {isLoadingHistory ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : messages.length === 0 ? (
              <div className="space-y-6">
                <div className="text-center py-8">
                  <img 
                    src="/images/assistente-globalsys.png" 
                    alt="Assistente virtual Globalsys"
                    className="w-16 h-16 rounded-full object-cover mx-auto mb-4"
                  />
                  <h3 className="font-semibold text-lg mb-2">{t("globalChat.howCanIHelp")}</h3>
                  <p className="text-muted-foreground">
                    {t("globalChat.askAboutPlatform")}
                  </p>
                </div>
                <div className="space-y-3">
                  <p className="text-sm font-medium text-muted-foreground">{t("globalChat.suggestions")}</p>
                  <div className="grid gap-2">
                    {suggestedQuestions.map((question, index) => (
                      <Button
                        key={index}
                        variant="outline"
                        className="justify-start text-left h-auto py-3 px-4"
                        onClick={() => sendMessage(question)}
                      >
                        <Sparkles className="w-4 h-4 mr-2 flex-shrink-0" />
                        {question}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={`flex gap-3 ${
                      message.sender_type === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    {message.sender_type === "assistant" && (
                      <img 
                        src="/images/assistente-globalsys.png" 
                        alt="Assistente virtual Globalsys"
                        className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                      />
                    )}
                    <div
                      className={`max-w-[80%] rounded-lg p-3 ${
                        message.sender_type === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                      }`}
                    >
                      <p className="text-sm whitespace-pre-wrap">
                        {formatMessage(message.message_text)}
                      </p>
                    </div>
                    {message.sender_type === "user" && (
                      <div className="w-8 h-8 bg-secondary rounded-full flex items-center justify-center flex-shrink-0">
                        <User className="w-4 h-4" />
                      </div>
                    )}
                  </div>
                ))}
                {isLoading && (
                  <div className="flex gap-3 justify-start">
                    <img 
                      src="/images/assistente-globalsys.png" 
                      alt="Assistente virtual Globalsys"
                      className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                    />
                    <div className="bg-muted rounded-lg p-3">
                      <Loader2 className="w-4 h-4 animate-spin" />
                    </div>
                  </div>
                )}
                <div ref={scrollRef} />
              </div>
            )}
          </ScrollArea>

          {/* Input area */}
          <div className="p-4 border-t border-border/40">
            <div className="flex gap-2">
              <Textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("globalChat.placeholder")}
                className="min-h-[60px] resize-none"
                disabled={isLoading}
              />
              <Button
                onClick={() => sendMessage()}
                disabled={isLoading || !inputValue.trim()}
                className="bg-gradient-primary h-[60px] px-4"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </Button>
            </div>
          </div>
        </Card>
      </main>
    </div>
  );
};

export default GlobalChat;
