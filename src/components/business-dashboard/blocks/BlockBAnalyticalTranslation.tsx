import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Brain, TrendingUp, TrendingDown, HelpCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface FeatureImportance {
  feature_name: string;
  importance_value: number;
}

interface BlockBAnalyticalTranslationProps {
  projectId: string;
  problemType: string;
  productionModelId: string | null;
}

export function BlockBAnalyticalTranslation({
  projectId,
  problemType,
  productionModelId,
}: BlockBAnalyticalTranslationProps) {
  const [features, setFeatures] = useState<FeatureImportance[]>([]);
  const [modelMetrics, setModelMetrics] = useState<Record<string, number>>({});
  const [baselineMetrics, setBaselineMetrics] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (!productionModelId) {
        setLoading(false);
        return;
      }

      try {
        const [featRes, metricsRes, modelRes] = await Promise.all([
          supabase
            .from('project_feature_importances')
            .select('feature_name, importance_value')
            .eq('project_model_id', productionModelId)
            .order('importance_value', { ascending: false })
            .limit(10),
          supabase
            .from('project_model_metrics')
            .select('metric_name, metric_value')
            .eq('project_model_id', productionModelId),
          supabase
            .from('project_models')
            .select('hyperparameters')
            .eq('id', productionModelId)
            .single(),
        ]);

        if (featRes.data) setFeatures(featRes.data);
        if (metricsRes.data) {
          const m: Record<string, number> = {};
          metricsRes.data.forEach(({ metric_name, metric_value }) => {
            m[metric_name] = metric_value;
          });
          setModelMetrics(m);
        }
        if (modelRes.data?.hyperparameters) {
          const hp = modelRes.data.hyperparameters as any;
          if (hp?.baseline_metrics) {
            setBaselineMetrics(hp.baseline_metrics);
          }
        }
      } catch (err) {
        console.error('[BlockB] Error loading:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [productionModelId]);

  const isRegression = problemType === 'regression';

  const totalImportance = features.reduce((s, f) => s + f.importance_value, 0);
  const topFeatures = features.slice(0, 5);
  const topFeaturesExplained = topFeatures.reduce((s, f) => s + f.importance_value, 0);
  const topPct = totalImportance > 0 ? (topFeaturesExplained / totalImportance) * 100 : 0;

  const colors = [
    'hsl(var(--chart-1))',
    'hsl(var(--chart-2))',
    'hsl(var(--chart-3))',
    'hsl(var(--chart-4))',
    'hsl(var(--chart-5))',
    'hsl(var(--muted-foreground))',
  ];

  const chartData = features.slice(0, 8).map((f, i) => ({
    name: f.feature_name.length > 20 ? f.feature_name.slice(0, 20) + '…' : f.feature_name,
    fullName: f.feature_name,
    value: f.importance_value,
    pct: totalImportance > 0 ? (f.importance_value / totalImportance) * 100 : 0,
    fill: colors[Math.min(i, colors.length - 1)],
  }));

  // What the model can/cannot explain
  const getModelCapability = () => {
    if (isRegression) {
      const r2 = modelMetrics['r2'] ?? modelMetrics['R²'] ?? null;
      if (r2 === null) return { explains: null, notExplains: null };
      const explainsPct = Math.max(0, r2 * 100);
      return {
        explains: `O modelo explica ${explainsPct.toFixed(0)}% da variação nos dados.`,
        notExplains: `${(100 - explainsPct).toFixed(0)}% da variação permanece inexplicada — fatores externos, dados faltantes ou complexidade não capturada.`,
      };
    }
    const auc = modelMetrics['auc'] ?? modelMetrics['AUC'] ?? null;
    if (auc === null) return { explains: null, notExplains: null };
    if (auc > 0.85) {
      return {
        explains: `O modelo separa bem as classes (AUC = ${(auc * 100).toFixed(1)}%). A maioria dos padrões no dado é capturada.`,
        notExplains: 'Casos próximos ao limiar de decisão podem ser menos precisos.',
      };
    }
    return {
      explains: `O modelo consegue separar parcialmente as classes (AUC = ${(auc * 100).toFixed(1)}%).`,
      notExplains: 'Parte significativa dos padrões não é capturada. Novos dados ou features podem melhorar a separação.',
    };
  };

  const capability = getModelCapability();

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Carregando análise…
        </CardContent>
      </Card>
    );
  }

  if (features.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="w-5 h-5" />
            Tradução Analítica → Negócio
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-6">
            Sem dados de importância de variáveis. Treine e promova um modelo para produção.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="w-5 h-5" />
          Tradução Analítica → Negócio
        </CardTitle>
        <CardDescription>
          O que aprendemos sobre o negócio analisando esses dados
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Feature Importance Chart */}
        <div>
          <h4 className="text-sm font-semibold mb-3">Variáveis mais influentes</h4>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} />
                <XAxis type="number" tickFormatter={(v) => `${v.toFixed(1)}%`} />
                <YAxis dataKey="name" type="category" width={130} tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(value: number) => [`${value.toFixed(2)}%`, 'Importância']}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName || ''}
                />
                <Bar dataKey="pct" radius={[0, 4, 4, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            As top {topFeatures.length} variáveis representam {topPct.toFixed(0)}% da capacidade explicativa do modelo.
          </p>
        </div>

        {/* Model capability */}
        <div className="grid md:grid-cols-2 gap-4">
          {capability.explains && (
            <div className="p-4 rounded-lg bg-green-600/5 border border-green-600/20">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-green-600" />
                <h4 className="text-sm font-semibold text-green-700 dark:text-green-400">
                  O que o modelo consegue explicar
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">{capability.explains}</p>
            </div>
          )}
          {capability.notExplains && (
            <div className="p-4 rounded-lg bg-yellow-600/5 border border-yellow-600/20">
              <div className="flex items-center gap-2 mb-2">
                <HelpCircle className="w-4 h-4 text-yellow-600" />
                <h4 className="text-sm font-semibold text-yellow-700 dark:text-yellow-400">
                  O que o modelo NÃO consegue explicar
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">{capability.notExplains}</p>
            </div>
          )}
        </div>

        {/* Baseline comparison */}
        {Object.keys(baselineMetrics).length > 0 && (
          <div className="p-4 rounded-lg bg-muted/50 border border-border">
            <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-muted-foreground" />
              Comparação com Baseline
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(baselineMetrics).map(([key, val]) => {
                const modelVal = modelMetrics[key];
                const improvement = modelVal !== undefined ? modelVal - val : null;
                return (
                  <div key={key} className="space-y-0.5">
                    <p className="text-xs text-muted-foreground uppercase">{key}</p>
                    <p className="text-sm">
                      <span className="font-mono">{typeof val === 'number' ? val.toFixed(3) : val}</span>
                      {improvement !== null && (
                        <Badge
                          variant={improvement > 0 ? 'default' : 'destructive'}
                          className="ml-2 text-[10px] px-1 py-0"
                        >
                          {improvement > 0 ? '+' : ''}{improvement.toFixed(3)}
                        </Badge>
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
