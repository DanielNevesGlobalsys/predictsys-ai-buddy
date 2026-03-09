import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Sparkles, Info, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface FeatureImportance {
  feature_name: string;
  importance_value: number;
}

interface DashboardFeatureImportanceProps {
  featureImportances: FeatureImportance[];
  projectId?: string;
}

/**
 * Maps common technical column names to business-friendly labels.
 */
const FEATURE_BUSINESS_LABELS: Record<string, string> = {
  // Common patterns
  codparc: "Identificador de cliente",
  cod_parc: "Identificador de cliente",
  id_cliente: "Identificador de cliente",
  customer_id: "Identificador de cliente",
  qtdneg: "Frequência de compras",
  qtd_neg: "Frequência de compras",
  qtd_compras: "Frequência de compras",
  purchase_count: "Frequência de compras",
  vlrtot: "Volume financeiro total",
  vlr_tot: "Volume financeiro total",
  total_value: "Volume financeiro total",
  revenue: "Receita gerada",
  recencia: "Tempo desde última interação",
  recency: "Tempo desde última interação",
  days_since_last: "Dias desde última atividade",
  frequencia: "Frequência de atividade",
  frequency: "Frequência de atividade",
  ticket_medio: "Ticket médio",
  avg_ticket: "Ticket médio",
  average_order_value: "Valor médio por pedido",
  idade: "Faixa etária",
  age: "Faixa etária",
  tenure: "Tempo como cliente",
  tempo_cliente: "Tempo como cliente",
  canal: "Canal de origem",
  channel: "Canal de origem",
  regiao: "Região geográfica",
  region: "Região geográfica",
  estado: "Estado",
  state: "Estado",
  cidade: "Cidade",
  city: "Cidade",
  segmento: "Segmento de mercado",
  segment: "Segmento de mercado",
  produto: "Categoria de produto",
  product: "Categoria de produto",
  category: "Categoria",
  campanha: "Campanha de marketing",
  campaign: "Campanha de marketing",
  dt_ref: "Data de referência",
  created_at: "Data de criação",
  updated_at: "Última atualização",
  score: "Pontuação calculada",
  status: "Status atual",
  situacao: "Situação cadastral",
  ativo: "Cliente ativo",
  churn: "Indicador de perda",
  cancelou: "Cancelamento",
  inadimplente: "Inadimplência",
  contrato: "Tipo de contrato",
  plano: "Tipo de plano",
};

function getBusinessLabel(featureName: string): string {
  const lower = featureName.toLowerCase().trim();
  
  // Exact match
  if (FEATURE_BUSINESS_LABELS[lower]) return FEATURE_BUSINESS_LABELS[lower];
  
  // Partial match (prefix/suffix)
  for (const [pattern, label] of Object.entries(FEATURE_BUSINESS_LABELS)) {
    if (lower.includes(pattern) || pattern.includes(lower)) return label;
  }
  
  // Heuristic: clean up underscores/camelCase
  return featureName
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, c => c.toUpperCase());
}

const DashboardFeatureImportance = ({ featureImportances, projectId }: DashboardFeatureImportanceProps) => {
  const { t } = useTranslation();
  const [aiInterpretation, setAiInterpretation] = useState<string | null>(null);
  const [loadingAi, setLoadingAi] = useState(false);

  // Load stored AI interpretation for feature importance
  useEffect(() => {
    if (!projectId) return;
    supabase
      .from("project_ai_context")
      .select("context")
      .eq("project_id", projectId)
      .maybeSingle()
      .then(({ data }) => {
        const ctx = data?.context as Record<string, any> | null;
        const interp = ctx?.lys_model_interpretation?.key_drivers_narrative;
        if (interp) setAiInterpretation(interp);
      });
  }, [projectId]);

  if (!featureImportances || featureImportances.length === 0) {
    return null;
  }

  const chartData = featureImportances.slice(0, 10).map(f => ({
    name: getBusinessLabel(f.feature_name),
    technicalName: f.feature_name,
    value: f.importance_value,
  }));

  // Truncate long labels for chart
  const chartDisplayData = chartData.map(d => ({
    ...d,
    displayName: d.name.length > 20 ? d.name.substring(0, 20) + "…" : d.name,
  }));

  const maxImportance = Math.max(...featureImportances.map(f => f.importance_value));

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">Principais fatores associados ao comportamento previsto</h3>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Estes são os fatores que mais influenciam o resultado previsto pelo modelo, traduzidos para linguagem de negócio.
      </p>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Bar Chart with business labels */}
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartDisplayData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis type="number" domain={[0, "auto"]} className="text-xs" />
              <YAxis dataKey="displayName" type="category" width={140} className="text-xs" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
                formatter={(value: number) => [(value * 100).toFixed(1) + "%", "Influência relativa"]}
                labelFormatter={(label) => {
                  const item = chartDisplayData.find(d => d.displayName === label);
                  return item ? `${item.name} (${item.technicalName})` : label;
                }}
              />
              <Bar
                dataKey="value"
                fill="hsl(var(--primary))"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Table with business + technical names */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fator de Negócio</TableHead>
                <TableHead className="text-right">Influência</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {featureImportances.slice(0, 10).map((feature, index) => {
                const businessLabel = getBusinessLabel(feature.feature_name);
                const isMapped = businessLabel !== feature.feature_name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase());
                return (
                  <TableRow key={feature.feature_name}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground font-mono">#{index + 1}</span>
                        <div>
                          <span className="font-medium text-sm">{businessLabel}</span>
                          {isMapped && (
                            <p className="text-[10px] text-muted-foreground font-mono">{feature.feature_name}</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full"
                            style={{ width: `${(feature.importance_value / maxImportance) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground w-10 text-right font-mono">
                          {((feature.importance_value / maxImportance) * 100).toFixed(0)}%
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* AI Interpretation */}
      <div className="mt-6 p-4 bg-muted/30 rounded-lg flex gap-3">
        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground">
          {aiInterpretation ? (
            <p>{aiInterpretation}</p>
          ) : (
            <p>
              Os fatores listados acima representam as variáveis que mais contribuem para as previsões do modelo.
              Quanto maior a barra, maior a influência desse fator no resultado previsto.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
};

export default DashboardFeatureImportance;
