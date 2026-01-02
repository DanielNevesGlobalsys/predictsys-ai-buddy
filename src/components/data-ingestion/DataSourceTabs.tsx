import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileSpreadsheet, Database, Cloud } from "lucide-react";
import FileUploadSection from "./FileUploadSection";
import DatabaseConnectorSection from "./DatabaseConnectorSection";
import CloudConnectorSection from "./CloudConnectorSection";
import type { ProjectData } from "../wizard/WizardContainer";

interface DataSourceTabsProps {
  projectData: ProjectData;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  onDataReady: () => void;
}

const DataSourceTabs = ({ projectData, saveProject, onDataReady }: DataSourceTabsProps) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState("files");

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3 h-auto p-1">
          <TabsTrigger 
            value="files" 
            className="flex flex-col items-center gap-2 py-4 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <FileSpreadsheet className="w-5 h-5" />
            <span className="text-sm font-medium">{t("dataIngestion.tabs.files")}</span>
          </TabsTrigger>
          <TabsTrigger 
            value="databases" 
            className="flex flex-col items-center gap-2 py-4 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Database className="w-5 h-5" />
            <span className="text-sm font-medium">{t("dataIngestion.tabs.databases")}</span>
          </TabsTrigger>
          <TabsTrigger 
            value="cloud" 
            className="flex flex-col items-center gap-2 py-4 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Cloud className="w-5 h-5" />
            <span className="text-sm font-medium">{t("dataIngestion.tabs.cloud")}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="mt-6">
          <FileUploadSection 
            projectData={projectData} 
            saveProject={saveProject} 
            onDataReady={onDataReady}
          />
        </TabsContent>

        <TabsContent value="databases" className="mt-6">
          <DatabaseConnectorSection 
            projectData={projectData} 
            saveProject={saveProject} 
            onDataReady={onDataReady}
          />
        </TabsContent>

        <TabsContent value="cloud" className="mt-6">
          <CloudConnectorSection 
            projectData={projectData} 
            saveProject={saveProject} 
            onDataReady={onDataReady}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default DataSourceTabs;
