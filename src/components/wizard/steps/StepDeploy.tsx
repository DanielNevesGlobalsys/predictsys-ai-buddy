import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Rocket, Globe, Code, Copy, CheckCircle } from "lucide-react";
import { useState } from "react";
import type { ProjectData } from "../WizardContainer";

interface StepDeployProps {
  projectData: ProjectData;
  onBack: () => void;
  onComplete: () => void;
  loading: boolean;
}

const StepDeploy = ({ projectData, onBack, onComplete, loading }: StepDeployProps) => {
  const [copied, setCopied] = useState(false);

  const exampleEndpoint = `https://api.predictsys.ai/v1/predict/${projectData.id || "seu-projeto-id"}`;
  
  const exampleRequest = `curl -X POST "${exampleEndpoint}" \\
  -H "Authorization: Bearer SEU_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "idade": 35,
    "salario": 5000,
    "cidade": "São Paulo"
  }'`;

  const handleCopy = () => {
    navigator.clipboard.writeText(exampleRequest);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Rocket className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            Deploy e API
          </h2>
          <p className="text-muted-foreground">
            Coloque seu modelo em produção e consuma via API REST
          </p>
        </div>

        {/* Info about deployment */}
        <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-accent">O que é o Deploy?</strong> Quando você faz o deploy, 
            seu modelo fica disponível para fazer previsões em tempo real. Você pode integrar 
            com seus sistemas existentes através de uma API simples.
          </p>
        </div>

        {/* Model in production */}
        <div className="space-y-3">
          <h3 className="font-semibold">Modelo em Produção</h3>
          <div className="bg-muted/30 rounded-xl p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-muted rounded-xl flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-muted-foreground" />
              </div>
              <div className="flex-1">
                <p className="text-muted-foreground">
                  O modelo será selecionado automaticamente após o treinamento
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  (Funcionalidade completa em breve)
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* API Endpoint */}
        <div className="space-y-3">
          <h3 className="font-semibold flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            Endpoint da API
          </h3>
          <div className="bg-muted/30 rounded-xl p-4">
            <code className="text-sm text-primary break-all">{exampleEndpoint}</code>
          </div>
        </div>

        {/* Example request */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <Code className="w-4 h-4 text-secondary" />
              Exemplo de Requisição
            </h3>
            <Button variant="ghost" size="sm" onClick={handleCopy}>
              {copied ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-1 text-accent" />
                  Copiado!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-1" />
                  Copiar
                </>
              )}
            </Button>
          </div>
          <div className="bg-foreground/5 rounded-xl p-4 overflow-x-auto">
            <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-mono">
              {exampleRequest}
            </pre>
          </div>
        </div>

        {/* Placeholder for response */}
        <div className="space-y-3">
          <h3 className="font-semibold">Exemplo de Resposta</h3>
          <div className="bg-foreground/5 rounded-xl p-4">
            <pre className="text-sm text-muted-foreground font-mono">
{`{
  "prediction": "sim",
  "probability": 0.87,
  "model": "Random Forest",
  "timestamp": "2024-01-15T10:30:00Z"
}`}
            </pre>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            Voltar
          </Button>
          <Button
            onClick={onComplete}
            disabled={loading}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {loading ? "Finalizando..." : "Concluir Projeto"}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDeploy;
