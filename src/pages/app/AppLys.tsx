import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Send, Sparkles, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import AppShell from '@/components/app/AppShell';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const suggestedQuestions = [
  "O que está mais crítico hoje?",
  "Quais campanhas deram resultado?",
  "Onde estamos perdendo mais receita?",
  "Qual projeto merece atenção imediata?",
];

const AppLys = () => {
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project_id');
  const { currentOrganization } = useOrganization();
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const init = async () => {
      // If coming from a project, fetch project name and add intro message
      if (projectId) {
        const { data: project } = await supabase
          .from('projects')
          .select('name')
          .eq('id', projectId)
          .single();
        
        if (project) {
          setProjectName(project.name);
          setMessages([{
            id: 'intro',
            role: 'assistant',
            content: `Estou analisando os dados do projeto **${project.name}**. O que você quer saber?`,
            timestamp: new Date(),
          }]);
        }
      } else {
        // Generic greeting
        setMessages([{
          id: 'intro',
          role: 'assistant',
          content: `Olá! Sou a **Lys**, sua assistente de IA para decisões de negócio. Como posso ajudar você hoje?`,
          timestamp: new Date(),
        }]);
      }
      setInitializing(false);
    };

    init();
  }, [projectId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (messageText?: string) => {
    const text = messageText || input.trim();
    if (!text || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      // Call the global-chat edge function with context
      const { data: { session } } = await supabase.auth.getSession();
      
      const response = await supabase.functions.invoke('global-chat', {
        body: {
          message: text,
          context: {
            organization_id: currentOrganization?.id,
            project_id: projectId,
            mode: 'executive',
          },
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.data?.response || 'Desculpe, não consegui processar sua pergunta. Tente novamente.',
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Desculpe, ocorreu um erro ao processar sua pergunta. Por favor, tente novamente.',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <AppShell title={projectName ? `Lys • ${projectName}` : 'Lys'}>
      <div className="flex flex-col h-[calc(100vh-8rem)] max-w-lg mx-auto">
        {/* Messages area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {initializing ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-3/4 rounded-xl" />
            </div>
          ) : (
            <>
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                      message.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted'
                    }`}
                  >
                    {message.role === 'assistant' && (
                      <div className="flex items-center gap-1.5 mb-1">
                        <Sparkles className="w-4 h-4 text-primary" />
                        <span className="text-xs font-medium text-primary">Lys</span>
                      </div>
                    )}
                    <p className="text-sm whitespace-pre-wrap">
                      {message.content.split('**').map((part, i) => 
                        i % 2 === 1 ? <strong key={i}>{part}</strong> : part
                      )}
                    </p>
                  </div>
                </div>
              ))}
              
              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-2xl px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      <span className="text-sm text-muted-foreground">Pensando...</span>
                    </div>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Suggested questions (only show when no user messages yet) */}
        {messages.length <= 1 && !isLoading && (
          <div className="px-4 pb-2">
            <p className="text-xs text-muted-foreground mb-2">Sugestões:</p>
            <div className="flex flex-wrap gap-2">
              {suggestedQuestions.map((question, index) => (
                <button
                  key={index}
                  onClick={() => handleSend(question)}
                  className="text-xs px-3 py-1.5 bg-muted rounded-full hover:bg-muted/80 transition-colors text-left"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input area */}
        <div className="p-4 border-t bg-background">
          <div className="flex items-end gap-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Pergunte algo sobre seu negócio..."
              className="min-h-[44px] max-h-32 resize-none"
              rows={1}
            />
            <Button
              onClick={() => handleSend()}
              disabled={!input.trim() || isLoading}
              size="icon"
              className="h-11 w-11 flex-shrink-0"
            >
              <Send className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </div>
    </AppShell>
  );
};

export default AppLys;
