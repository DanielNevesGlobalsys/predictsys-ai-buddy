import { Smartphone, BarChart3, TrendingUp, MessageCircle, Clock, AlertTriangle, DollarSign, Target } from 'lucide-react';
import AppShell from '@/components/app/AppShell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

const AppQuickGuide = () => {
  return (
    <AppShell title="Guia Rápido" showBackButton>
      <div className="p-4 space-y-6 pb-8">
        {/* Header */}
        <div className="text-center pt-4 pb-2">
          <div className="inline-flex p-3 rounded-full bg-primary/10 mb-4">
            <Smartphone className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">
            Guia do App Executivo
          </h1>
          <p className="text-muted-foreground mt-2">
            Tudo o que você precisa saber para acompanhar seus projetos de IA
          </p>
        </div>

        {/* What is this app */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              O que é o App Executivo?
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>
              O App Executivo é uma versão simplificada do PredictSys, focada em 
              <strong className="text-foreground"> acompanhamento e visualização</strong>.
            </p>
            <p>
              Aqui você vê os resultados dos seus projetos de IA preditiva, 
              acompanha campanhas e entende o impacto no negócio.
            </p>
          </CardContent>
        </Card>

        {/* Key Metrics */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground">
            Métricas Principais
          </h2>

          <Card className="bg-card border-border">
            <CardContent className="p-4 space-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-destructive/10">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <h3 className="font-medium text-foreground">Receita em Risco</h3>
                  <p className="text-sm text-muted-foreground">
                    Valor que pode ser perdido se clientes de alto risco não forem acionados. 
                    Calculado com base nas probabilidades do modelo.
                  </p>
                </div>
              </div>

              <Separator />

              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <DollarSign className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <h3 className="font-medium text-foreground">Oportunidade</h3>
                  <p className="text-sm text-muted-foreground">
                    Valor potencial que pode ser capturado com ações nos segmentos identificados. 
                    É o upside das suas campanhas.
                  </p>
                </div>
              </div>

              <Separator />

              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <TrendingUp className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-medium text-foreground">ROI Líquido</h3>
                  <p className="text-sm text-muted-foreground">
                    Retorno sobre investimento das campanhas concluídas. 
                    Considera receita gerada menos custos de contato.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Time Horizons */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            Horizontes de Tempo
          </h2>

          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-2xl font-bold text-destructive">30d</p>
                  <p className="text-xs text-muted-foreground">Curto prazo</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-2xl font-bold text-yellow-500">60d</p>
                  <p className="text-xs text-muted-foreground">Médio prazo</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-2xl font-bold text-accent">90d</p>
                  <p className="text-xs text-muted-foreground">Longo prazo</p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mt-4">
                Os modelos calculam a probabilidade de um evento (ex: churn, recompra) 
                ocorrer dentro de cada horizonte de tempo.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Campaigns Section */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            Campanhas e Ações
          </h2>

          <Card className="bg-card border-border">
            <CardContent className="p-4 text-sm text-muted-foreground space-y-3">
              <p>
                As campanhas são criadas no <strong className="text-foreground">painel web</strong> e 
                aparecem aqui para acompanhamento.
              </p>
              <p>
                Você pode ver: nome da ação, tipo (WhatsApp, E-mail, etc.), 
                status, clientes alvo e resultado financeiro.
              </p>
              <p>
                Campanhas <strong className="text-foreground">concluídas</strong> com 
                conversão observada preenchida entram no cálculo de ROI.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Lys Section */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-primary" />
            A Lys
          </h2>

          <Card className="bg-card border-border">
            <CardContent className="p-4 text-sm text-muted-foreground space-y-3">
              <p>
                A Lys é sua assistente de IA para perguntas de negócio.
              </p>
              <p>
                Pergunte coisas como:
              </p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>"O que está mais crítico hoje?"</li>
                <li>"Quais campanhas deram resultado?"</li>
                <li>"Onde estamos perdendo mais receita?"</li>
              </ul>
              <p>
                Ela usa o contexto da organização e projeto para responder.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* App vs Web */}
        <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
          <h3 className="font-medium text-foreground mb-2">
            📱 App vs 💻 Web
          </h3>
          <p className="text-sm text-muted-foreground">
            O <strong>App</strong> é para acompanhamento executivo (visualizar, perguntar).
            O <strong>Web</strong> é para operação completa (criar projetos, treinar modelos, 
            cadastrar campanhas, configurar).
          </p>
        </div>
      </div>
    </AppShell>
  );
};

export default AppQuickGuide;
