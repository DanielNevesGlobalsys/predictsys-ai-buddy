import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
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
  Cell,
} from "recharts";
import { Layers, Info, Users } from "lucide-react";

interface DashboardSegmentationProps {
  problemType: string;
  productionModelId: string;
}

const DashboardSegmentation = ({ problemType, productionModelId }: DashboardSegmentationProps) => {
  const { t } = useTranslation();

  const classificationSegments = useMemo(() => [
    { range: "Baixo risco", count: 4500, percent: 45, avgTarget: 0.02, business: "Entidades estáveis — manter engajamento" },
    { range: "Risco moderado-baixo", count: 2000, percent: 20, avgTarget: 0.08, business: "Atenção preventiva recomendada" },
    { range: "Risco moderado", count: 1500, percent: 15, avgTarget: 0.25, business: "Intervenção ativa sugerida" },
    { range: "Risco elevado", count: 1200, percent: 12, avgTarget: 0.55, business: "Prioridade alta — ação imediata" },
    { range: "Risco crítico", count: 800, percent: 8, avgTarget: 0.85, business: "Urgente — maior probabilidade de evento" },
  ], []);

  const regressionSegments = useMemo(() => [
    { range: "Quartil 1 (menor)", count: 2500, percent: 25, avgTarget: 150, business: "Valor previsto mais baixo" },
    { range: "Quartil 2", count: 2500, percent: 25, avgTarget: 450, business: "Valor previsto intermediário-baixo" },
    { range: "Quartil 3", count: 2500, percent: 25, avgTarget: 850, business: "Valor previsto intermediário-alto" },
    { range: "Quartil 4 (maior)", count: 2500, percent: 25, avgTarget: 1500, business: "Maior potencial de valor" },
  ], []);

  const segments = problemType === "classification" ? classificationSegments : regressionSegments;

  const colors = [
    "hsl(var(--accent))",
    "hsl(var(--primary) / 0.5)",
    "hsl(var(--primary) / 0.7)",
    "hsl(var(--primary))",
    "hsl(var(--destructive))",
  ];

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center gap-2 mb-2">
        <Users className="w-5 h-5 text-accent" />
        <h3 className="font-semibold">
          {problemType === "classification"
            ? "Distribuição das entidades por nível de risco"
            : "Distribuição das entidades por valor previsto"}
        </h3>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {problemType === "classification"
          ? "Visualize como as entidades analisadas se distribuem entre os diferentes níveis de probabilidade do evento previsto."
          : "Visualize como as entidades analisadas se distribuem entre as faixas de valor previsto pelo modelo."}
      </p>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Bar Chart */}
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={segments}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="range" className="text-xs" tick={{ fontSize: 10 }} />
              <YAxis className="text-xs" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
                formatter={(value: number) => [
                  value.toLocaleString() + " entidades",
                  "Quantidade",
                ]}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {segments.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Table with business interpretation */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Segmento</TableHead>
                <TableHead className="text-right">Entidades</TableHead>
                <TableHead className="text-right">% da base</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((segment, index) => (
                <TableRow key={segment.range}>
                  <TableCell>
                    <div className="flex items-start gap-2">
                      <div
                        className="w-3 h-3 rounded-full mt-1 flex-shrink-0"
                        style={{ backgroundColor: colors[index % colors.length] }}
                      />
                      <div>
                        <span className="font-medium text-sm">{segment.range}</span>
                        <p className="text-[10px] text-muted-foreground">{segment.business}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {segment.count.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-sm">{segment.percent}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Business interpretation */}
      <div className="mt-6 p-4 bg-muted/30 rounded-lg flex gap-3">
        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <p className="text-sm text-muted-foreground">
          {problemType === "classification"
            ? "Esta distribuição mostra onde se concentram as entidades com maior probabilidade do evento previsto. Segmentos de risco elevado e crítico devem ser priorizados para ações preventivas."
            : "Esta distribuição mostra como os valores previstos se distribuem entre as entidades. Os quartis superiores representam as maiores oportunidades ou os maiores riscos de valor."}
        </p>
      </div>
    </Card>
  );
};

export default DashboardSegmentation;
