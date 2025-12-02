import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { BarChart3, TrendingUp, Loader2, Calculator, RefreshCw } from "lucide-react";

interface NumericStat {
  id: string;
  column_name: string;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
  median_value: number | null;
  std_value: number | null;
  null_count: number;
}

interface CategoricalStat {
  id: string;
  column_name: string;
  distinct_count: number;
  top_categories: { category: string; count: number }[];
}

interface EDADisplayProps {
  projectId: string;
  onEDAComplete?: () => void;
}

const EDADisplay = ({ projectId, onEDAComplete }: EDADisplayProps) => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [numericStats, setNumericStats] = useState<NumericStat[]>([]);
  const [categoricalStats, setCategoricalStats] = useState<CategoricalStat[]>([]);
  const [selectedNumericColumn, setSelectedNumericColumn] = useState<string>("");
  const [selectedCategoricalColumn, setSelectedCategoricalColumn] = useState<string>("");
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    loadEDAStats();
  }, [projectId]);

  const loadEDAStats = async () => {
    setLoading(true);
    try {
      const [numericResult, categoricalResult] = await Promise.all([
        supabase
          .from("project_numeric_stats")
          .select("*")
          .eq("project_id", projectId),
        supabase
          .from("project_categorical_stats")
          .select("*")
          .eq("project_id", projectId),
      ]);

      if (numericResult.data) {
        setNumericStats(numericResult.data);
        if (numericResult.data.length > 0 && !selectedNumericColumn) {
          setSelectedNumericColumn(numericResult.data[0].column_name);
        }
      }

      if (categoricalResult.data) {
        const parsed = categoricalResult.data.map((item) => ({
          ...item,
          top_categories: typeof item.top_categories === "string"
            ? JSON.parse(item.top_categories)
            : item.top_categories || [],
        }));
        setCategoricalStats(parsed);
        if (parsed.length > 0 && !selectedCategoricalColumn) {
          setSelectedCategoricalColumn(parsed[0].column_name);
        }
      }

      setHasData(
        (numericResult.data?.length || 0) > 0 ||
        (categoricalResult.data?.length || 0) > 0
      );
    } catch (error) {
      console.error("Erro ao carregar EDA:", error);
    }
    setLoading(false);
  };

  const calculateEDA = async () => {
    setCalculating(true);
    try {
      const { data, error } = await supabase.functions.invoke("calculate-eda", {
        body: { project_id: projectId },
      });

      if (error) throw error;

      toast({
        title: "EDA calculada com sucesso!",
        description: "As estatísticas foram geradas para suas colunas.",
      });

      await loadEDAStats();
      onEDAComplete?.();
    } catch (error: any) {
      console.error("Erro ao calcular EDA:", error);
      toast({
        title: "Erro ao calcular EDA",
        description: error.message || "Tente novamente mais tarde.",
        variant: "destructive",
      });
    }
    setCalculating(false);
  };

  const formatNumber = (value: number | null): string => {
    if (value === null) return "-";
    if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(2) + "M";
    if (Math.abs(value) >= 1000) return (value / 1000).toFixed(2) + "K";
    return value.toFixed(2);
  };

  const selectedNumericData = numericStats.find(
    (s) => s.column_name === selectedNumericColumn
  );

  const selectedCategoricalData = categoricalStats.find(
    (s) => s.column_name === selectedCategoricalColumn
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="space-y-6">
        <div className="text-center py-8">
          <div className="w-16 h-16 bg-secondary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Calculator className="w-8 h-8 text-secondary" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Análise ainda não calculada</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            Clique no botão abaixo para gerar estatísticas e gráficos dos seus dados.
            Este processo pode levar alguns segundos dependendo do tamanho do arquivo.
          </p>
          <Button
            onClick={calculateEDA}
            disabled={calculating}
            className="bg-gradient-primary hover:shadow-hover"
          >
            {calculating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Calculando...
              </>
            ) : (
              <>
                <BarChart3 className="w-4 h-4 mr-2" />
                Calcular EDA agora
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with recalculate button */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Estas estatísticas ajudam você a entender a distribuição e características dos seus dados.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={calculateEDA}
          disabled={calculating}
        >
          {calculating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          <span className="ml-2">Recalcular</span>
        </Button>
      </div>

      {/* Numeric stats section */}
      {numericStats.length > 0 && (
        <Card className="bg-gradient-card shadow-card p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold">Colunas Numéricas</h3>
              <p className="text-sm text-muted-foreground">
                Estatísticas como média, mediana e valores extremos
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Coluna</TableHead>
                  <TableHead className="text-right">Mínimo</TableHead>
                  <TableHead className="text-right">Máximo</TableHead>
                  <TableHead className="text-right">Média</TableHead>
                  <TableHead className="text-right">Mediana</TableHead>
                  <TableHead className="text-right">Desvio Padrão</TableHead>
                  <TableHead className="text-right">Valores Nulos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {numericStats.map((stat) => (
                  <TableRow key={stat.id}>
                    <TableCell className="font-medium">{stat.column_name}</TableCell>
                    <TableCell className="text-right">{formatNumber(stat.min_value)}</TableCell>
                    <TableCell className="text-right">{formatNumber(stat.max_value)}</TableCell>
                    <TableCell className="text-right">{formatNumber(stat.mean_value)}</TableCell>
                    <TableCell className="text-right">{formatNumber(stat.median_value)}</TableCell>
                    <TableCell className="text-right">{formatNumber(stat.std_value)}</TableCell>
                    <TableCell className="text-right">{stat.null_count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Numeric column chart */}
          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center gap-4 mb-4">
              <span className="text-sm font-medium">Ver distribuição de:</span>
              <Select value={selectedNumericColumn} onValueChange={setSelectedNumericColumn}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {numericStats.map((stat) => (
                    <SelectItem key={stat.column_name} value={stat.column_name}>
                      {stat.column_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedNumericData && (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={[
                      { name: "Mínimo", value: selectedNumericData.min_value || 0 },
                      { name: "Média", value: selectedNumericData.mean_value || 0 },
                      { name: "Mediana", value: selectedNumericData.median_value || 0 },
                      { name: "Máximo", value: selectedNumericData.max_value || 0 },
                    ]}
                    margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="name" className="text-muted-foreground" />
                    <YAxis className="text-muted-foreground" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                    <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Categorical stats section */}
      {categoricalStats.length > 0 && (
        <Card className="bg-gradient-card shadow-card p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-secondary/10 rounded-lg flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-secondary" />
            </div>
            <div>
              <h3 className="font-semibold">Colunas Categóricas</h3>
              <p className="text-sm text-muted-foreground">
                Quantidade de categorias e valores mais frequentes
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Coluna</TableHead>
                  <TableHead className="text-right">Categorias Distintas</TableHead>
                  <TableHead>Valor Mais Frequente</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categoricalStats.map((stat) => (
                  <TableRow key={stat.id}>
                    <TableCell className="font-medium">{stat.column_name}</TableCell>
                    <TableCell className="text-right">{stat.distinct_count}</TableCell>
                    <TableCell>
                      {stat.top_categories[0]?.category || "-"}{" "}
                      <span className="text-muted-foreground">
                        ({stat.top_categories[0]?.count || 0})
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Categorical column chart */}
          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center gap-4 mb-4">
              <span className="text-sm font-medium">Ver top categorias de:</span>
              <Select
                value={selectedCategoricalColumn}
                onValueChange={setSelectedCategoricalColumn}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categoricalStats.map((stat) => (
                    <SelectItem key={stat.column_name} value={stat.column_name}>
                      {stat.column_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedCategoricalData && selectedCategoricalData.top_categories.length > 0 && (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={selectedCategoricalData.top_categories.slice(0, 10)}
                    layout="vertical"
                    margin={{ top: 5, right: 30, left: 100, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis type="number" className="text-muted-foreground" />
                    <YAxis
                      dataKey="category"
                      type="category"
                      className="text-muted-foreground"
                      width={90}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                    <Bar dataKey="count" fill="hsl(var(--secondary))" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
};

export default EDADisplay;
