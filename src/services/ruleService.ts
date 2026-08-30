/**

field_rule_id: 50
  campaign_id: 23
    rule_name: abandon_new_req
        state: INACTIVE
   event_list: QueueMemberPaused
   event_data: {"QueueMemberPaused":{"condition":[],"req_data":{"datatype":"PLAIN","method":"GET","url":"google.com","data_field":"agent_name=$basic['agent_name']&agent_email_id=$basic['agent_email_id']","packet_field":"agent_name,agent_email_id"}}}
   event_keys: {"QueueMemberPaused":"$basic['agent_name'],$basic['agent_email_id']"}
 event_fields: {"QueueMemberPaused":"agent_name,agent_email_id"}
        token: 0
   token_data:
flag_rule_new: 1
         uuid:
         buid:
         duid:
         suid:


*/
import { RowDataPacket } from "mysql2";
import { getAllActiveRules, select } from "../repository/repository";
import { RuleRow } from "../repository/repository";
type RuleMap = Map<number, Map<string, RuleRow[]>>;
type CampMap = Map<string, number>;

type PacketData = Record<string, any>;

export default class RuleService {
  private activeRuleMap: RuleMap = new Map();
  private campaignNameToIdMap: CampMap = new Map();

  private async loadCampaignHash(): Promise<void> {
    try{
      // Query the Database to get the campaign names and their corresponding IDs
      const campaigns = await select<Array<{ campaign_id: number; campaign_name: string } & RowDataPacket>>(
        "SELECT campaign_id, campaign_name FROM campaign limit 10"
      );

      if(!campaigns || campaigns.length === 0) {
        throw new Error("No campaigns found in the database");
      }

      
      // Populate the campaign name to ID map
      for (const campaign of campaigns) {
        const campaign_id = Number(campaign.campaign_id);
        if(isNaN(campaign_id)) {
          continue; // Skip if campaign_id is not a valid number
        }
        this.campaignNameToIdMap.set(campaign.campaign_name, campaign_id);
      }
    } catch (error) {
      throw new Error("RuleService: Failed to load campaign hashes", {
        cause: error,
      });
    }
  }

  private async loadErpHashes(): Promise<void> {
    try {
      const activeRulesArray = await getAllActiveRules();

      // console.log("Getting Active Rules:", activeRulesArray);

      const ruleMap = new Map();

      for (const rule of activeRulesArray) {
        const campaignId = rule.campaign_id;

        let campaignMap = ruleMap.get(campaignId);

        if (!campaignMap) {
          campaignMap = new Map<string, RuleRow[]>();
          ruleMap.set(campaignId, campaignMap);
        }

        const events = rule.event_list
          .split(",")
          .map((event) => event.trim())
          .filter(Boolean);

        for (const event of events) {
          let eventRules = campaignMap.get(event);

          if (!eventRules) {
            eventRules = [];
            campaignMap.set(event, eventRules);
          }

          eventRules.push(rule);
        }
      }

      this.activeRuleMap = ruleMap;
    } catch (error) {
      throw new Error("RuleService: Failed to load active rules", {
        cause: error,
      });
    }
  }

  public async loadHashes(): Promise<void> {
    try {
      await Promise.all([this.loadCampaignHash(), this.loadErpHashes()]);
    } catch (error) {
      throw new Error("RuleService: Failed to load hashes", {
        cause: error,
      });
    }
  }
	public getHashes(key: string): RuleMap | CampMap | null {
    switch (key) {
      case "erpRuleMap":
        return this.activeRuleMap;
      case "campaignMap":
        return this.campaignNameToIdMap;
      default:
        console.warn(`Unknown hash key requested: ${key}`);
        return null;
    }
	}

  public async processEvents(packet: PacketData) {
    switch (packet.Event) {
      case "QueueMemberPaused":
        await this.handleQueueMemberPaused(packet);
      break;
      default:
        console.warn(`Unhandled event: ${packet.event}`);
    }
  }

  private async handleQueueMemberPaused(packet: PacketData) {
    /**
     * Received packet: {
        Event: 'QueueMemberPaused',
        Privilege: 'all',
        NodeId: '44',
        Ipaddr: '192.168.1.220',
        In_ifc: '',
        Timestamp: '1787936914',
        Other: '112##+0530##,CmsId: 0',
        Queue: 'Amandeep_test',
        Location: 'Agent/2121',
        Paused: '1',
        Mode: 'Lunch_break',
        Ready: '0',
        SubCategory: ''
      }
    */
    const campaignName = packet.Queue;
    let campaignId = this.campaignNameToIdMap.get(campaignName);
    console.log(`Campaign Name: ${campaignName}, Campaign ID: ${campaignId}`);

    if(!campaignId) {
      // Get the campaign ID from the database or another source if not found in the map and set this in the map for future use.
      const campaigns = await select<Array<{ campaign_id: number; campaign_name: string } & RowDataPacket>>(
        "SELECT campaign_id, campaign_name FROM campaign where campaign_name = ? limit 1",
        [campaignName]
      );
      
      if(!campaigns || campaigns.length === 0) {
        console.log("No campaigns found in the database");
        return; // Exit the function if no campaigns are found
      }

      const campaign = campaigns[0];
      if (campaign && campaign.campaign_id) {
        this.campaignNameToIdMap.set(campaignName, campaign.campaign_id);
        campaignId = campaign.campaign_id;
      }
    }

    // Get the rules for this campaign and event
    if (!campaignId) {
      console.log("Campaign ID not found");
      return;
    }
    const campaignRules = this.activeRuleMap.get(campaignId);

    if (!campaignRules) {
      console.log("No rules found for this campaign");
      return;
    }

    const eventRules = campaignRules.get(packet.Event);

    if (!eventRules || eventRules.length === 0) {
      console.log("No rules found for this event");
      return;
    }


    /**
      {
        field_rule_id: 60,
        campaign_id: 24,
        rule_name: 'rule_mohit',
        state: 'ACTIVE',
        event_list: 'QueueMemberPaused,AgentComplete',
        event_data: `{"QueueMemberPaused":{"condition":{},"req_data":{"datatype":"JSON","method":"PATCH","url":"http://127.0.0.1/apps/anilOracle.php","data_field":{"agent_id":"$basic['agent_id']","campaign_name":"$basic['campaign_name']","break_status":"$basic['break_status']","dialer_type":"$basic['dialer_type']","reason":"$basic['reason']","agent_name":"$basic['agent_name']"},"packet_field":"agent_id,campaign_name,break_status,dialer_type,reason,agent_name"}},"AgentComplete":{"condition":{},"req_data":{"datatype":"JSON","method":"POST","url":"http://127.0.0.1/apps/anilOracle.php","data_field":{"agent_id":"$basic['agent_id']","agent_name":"$basic['agent_name']","agent_identity":"$basic['agent_identity']","campaign_name":"$basic['campaign_name']","call_end_date_time":"$basic['call_end_date_time']","call_start_date_time":"$basic['call_start_date_time']","custunique_id":"$basic['custunique_id']","phone_no":"$basic['phone_no']","did":"$basic['did']","session_id":"$basic['session_id']","call_type":"$basic['call_type']","call_duration":"$basic['call_duration']","disp":"$basic['disp']","lead_id":"$custom_crm['lead_id']","cust_disp":"$custom_crm['cust_disp']","cust_category":"$custom_crm['cust_category']"},"packet_field":"agent_id,agent_name,agent_identity,campaign_name,call_end_date_time,call_start_date_time,custunique_id,phone_no,did,session_id,call_type,call_duration,disp","custom_field":{"header":{"Content-Type":"application/json"}}}}}`,
        event_fields: '{"QueueMemberPaused":"agent_id,agent_name,campaign_name,reason,break_status,dialer_type","AgentComplete":"agent_id,agent_name,agent_identity,campaign_name,call_start_date_time,call_end_date_time,custunique_id,phone_no,did,session_id,call_type,call_duration,disp,cz_custom_crm###lead_id,cz_custom_crm###cust_disp,cz_custom_crm###cust_category"}'
      }

     */
    // Process each rule for this event
    for (const rule of eventRules) {
      // console.log("Rule: ", rule);
      // console.log(`Processing rule: ${rule.rule_name} for event: ${packet.Event}`);
      if(rule.campaign_id === campaignId) {
        // console.log(`Rule ${rule.rule_name} is applicable for campaign ID ${campaignId}`);
        const eventData = typeof rule.event_data === 'string' ? JSON.parse(rule.event_data)[packet.Event] : rule.event_data[packet.Event];
        // console.log(`Event Data for rule ${rule.rule_name}:`, eventData);
        const reqData = eventData?.req_data;
        if(reqData) {
          console.log(`Request Data for rule ${rule.rule_name}:`, reqData);
          // Here you can implement the logic to make HTTP requests or any other processing based on reqData

          const url = reqData.url;
          const method = reqData.method;
          // const method = 'POST';
          // 'agent_id,campaign_name,break_status,dialer_type,reason,agent_name'
          const packetFieldArr = reqData.packet_field.split(',').map((field: string) => field.trim()).filter(Boolean);
          
          // const packetFields = this.getFieldsFromPacket(packet, packetFieldArr);
          const agentId = packet.Location?.split('/')[1] || '';
          const campaignName = packet.Queue || '';
          const breakStatus = packet.Paused || '';
          const dialerType = '';
          const reason = packet.Mode || '';
          const agentName = 'TEST_AGENT'; // Replace with actual agent name extraction logic if available
          
          const dataField = {
            agent_id: agentId,
            campaign_name: campaignName,
            break_status: breakStatus,
            dialer_type: dialerType,
            reason: reason,
            agent_name: agentName
          };

          console.log(`Data Field for rule ${rule.rule_name}:`, dataField);

          console.log(`Final Curl Request: curl -X ${method} "${url}" -H "Content-Type: application/json" -d '${JSON.stringify(dataField)}'`);

        }
      }
      // Implement the logic to process the rule based on the packet data
      // This could involve making HTTP requests, updating databases, etc.
    }

  }
}
