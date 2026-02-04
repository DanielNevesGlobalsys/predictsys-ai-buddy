import { ExternalLink, BookOpen, FileText, HelpCircle, MessageCircle } from 'lucide-react';
import AppShell from '@/components/app/AppShell';
import { Card, CardContent } from '@/components/ui/card';

interface DocLink {
  title: string;
  description: string;
  icon: React.ReactNode;
  url?: string;
  internal?: boolean;
}

const docLinks: DocLink[] = [
  {
    title: 'Início Rápido',
    description: 'Como começar a usar o PredictSys',
    icon: <BookOpen className="h-5 w-5" />,
    internal: true,
  },
  {
    title: 'Conceitos de IA Preditiva',
    description: 'Entenda os fundamentos da plataforma',
    icon: <FileText className="h-5 w-5" />,
    internal: true,
  },
  {
    title: 'Métricas de Negócio',
    description: 'Como interpretar ROI, receita em risco e impacto',
    icon: <HelpCircle className="h-5 w-5" />,
    internal: true,
  },
  {
    title: 'Suporte',
    description: 'Entre em contato com nossa equipe',
    icon: <MessageCircle className="h-5 w-5" />,
    url: 'mailto:suporte@predictsys.com.br',
  },
];

const AppDocs = () => {
  return (
    <AppShell title="Documentação" showBackButton>
      <div className="p-4 space-y-6">
        {/* Header */}
        <div className="text-center pt-4 pb-2">
          <h1 className="text-2xl font-bold text-foreground">
            Central de Ajuda
          </h1>
          <p className="text-muted-foreground mt-1">
            Recursos para aproveitar ao máximo o PredictSys
          </p>
        </div>

        {/* Doc Links */}
        <div className="space-y-3">
          {docLinks.map((link, index) => (
            <Card 
              key={index}
              className="bg-card border-border cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => {
                if (link.url) {
                  window.open(link.url, '_blank');
                }
              }}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary">
                    {link.icon}
                  </div>
                  <div className="flex-1">
                    <h3 className="font-medium text-foreground">
                      {link.title}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {link.description}
                    </p>
                  </div>
                  {link.url && (
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Quick Tips */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            Dicas Rápidas
          </h2>
          
          <div className="space-y-3">
            <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
              <p className="text-sm text-foreground">
                💡 <strong>Dica:</strong> Use a Lys para perguntas sobre seus projetos. 
                Ela entende o contexto de negócio e pode te ajudar a interpretar os dados.
              </p>
            </div>
            
            <div className="p-4 rounded-lg bg-accent/10 border border-accent/20">
              <p className="text-sm text-foreground">
                📊 <strong>Big Numbers:</strong> Os valores de "Receita em Risco" são calculados 
                automaticamente com base nas probabilidades do modelo e no valor médio de venda configurado.
              </p>
            </div>
            
            <div className="p-4 rounded-lg bg-secondary/10 border border-secondary/20">
              <p className="text-sm text-foreground">
                🎯 <strong>Campanhas:</strong> As campanhas mostradas no app são cadastradas no 
                painel web. Aqui você acompanha resultados em tempo real.
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
};

export default AppDocs;
