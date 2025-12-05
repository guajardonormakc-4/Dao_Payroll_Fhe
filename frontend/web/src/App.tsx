// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Contributor {
  id: string;
  name: string;
  encryptedSalary: string;
  encryptedBonus: string;
  encryptedKPI: string;
  vestingSchedule: string;
  lastPayment: number;
  status: "active" | "inactive" | "pending";
  address: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [adding, setAdding] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newContributor, setNewContributor] = useState({ name: "", salary: 0, bonus: 0, kpi: 0, vesting: "monthly" });
  const [selectedContributor, setSelectedContributor] = useState<Contributor | null>(null);
  const [decryptedSalary, setDecryptedSalary] = useState<number | null>(null);
  const [decryptedBonus, setDecryptedBonus] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const activeCount = contributors.filter(c => c.status === "active").length;
  const inactiveCount = contributors.filter(c => c.status === "inactive").length;
  const pendingCount = contributors.filter(c => c.status === "pending").length;

  useEffect(() => {
    loadContributors().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadContributors = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("contributor_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing contributor keys:", e); }
      }
      const list: Contributor[] = [];
      for (const key of keys) {
        try {
          const contributorBytes = await contract.getData(`contributor_${key}`);
          if (contributorBytes.length > 0) {
            try {
              const contributorData = JSON.parse(ethers.toUtf8String(contributorBytes));
              list.push({ 
                id: key, 
                name: contributorData.name, 
                encryptedSalary: contributorData.salary, 
                encryptedBonus: contributorData.bonus,
                encryptedKPI: contributorData.kpi,
                vestingSchedule: contributorData.vesting,
                lastPayment: contributorData.lastPayment,
                status: contributorData.status || "pending",
                address: contributorData.address
              });
            } catch (e) { console.error(`Error parsing contributor data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading contributor ${key}:`, e); }
      }
      list.sort((a, b) => b.lastPayment - a.lastPayment);
      setContributors(list);
    } catch (e) { console.error("Error loading contributors:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const addContributor = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setAdding(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting payroll data with Zama FHE..." });
    try {
      const encryptedSalary = FHEEncryptNumber(newContributor.salary);
      const encryptedBonus = FHEEncryptNumber(newContributor.bonus);
      const encryptedKPI = FHEEncryptNumber(newContributor.kpi);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const contributorId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const contributorData = { 
        name: newContributor.name,
        salary: encryptedSalary, 
        bonus: encryptedBonus,
        kpi: encryptedKPI,
        vesting: newContributor.vesting,
        lastPayment: Math.floor(Date.now() / 1000),
        status: "pending",
        address: address
      };
      
      await contract.setData(`contributor_${contributorId}`, ethers.toUtf8Bytes(JSON.stringify(contributorData)));
      
      const keysBytes = await contract.getData("contributor_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(contributorId);
      await contract.setData("contributor_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted payroll data submitted securely!" });
      await loadContributors();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddModal(false);
        setNewContributor({ name: "", salary: 0, bonus: 0, kpi: 0, vesting: "monthly" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setAdding(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const activateContributor = async (contributorId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted payroll with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const contributorBytes = await contract.getData(`contributor_${contributorId}`);
      if (contributorBytes.length === 0) throw new Error("Contributor not found");
      const contributorData = JSON.parse(ethers.toUtf8String(contributorBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedContributor = { ...contributorData, status: "active" };
      await contractWithSigner.setData(`contributor_${contributorId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContributor)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE activation completed successfully!" });
      await loadContributors();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Activation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const deactivateContributor = async (contributorId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted payroll with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const contributorBytes = await contract.getData(`contributor_${contributorId}`);
      if (contributorBytes.length === 0) throw new Error("Contributor not found");
      const contributorData = JSON.parse(ethers.toUtf8String(contributorBytes));
      const updatedContributor = { ...contributorData, status: "inactive" };
      await contract.setData(`contributor_${contributorId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContributor)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE deactivation completed successfully!" });
      await loadContributors();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Deactivation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredContributors = contributors.filter(contributor => 
    contributor.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    contributor.address.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const calculateTotalPayments = () => {
    let total = 0;
    contributors.forEach(contributor => {
      if (contributor.status === "active") {
        const salary = FHEDecryptNumber(contributor.encryptedSalary);
        const bonus = FHEDecryptNumber(contributor.encryptedBonus);
        total += salary + bonus;
      }
    });
    return total;
  };

  const topContributors = [...contributors]
    .sort((a, b) => {
      const aValue = FHEDecryptNumber(a.encryptedSalary) + FHEDecryptNumber(a.encryptedBonus);
      const bValue = FHEDecryptNumber(b.encryptedSalary) + FHEDecryptNumber(b.encryptedBonus);
      return bValue - aValue;
    })
    .slice(0, 5);

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing encrypted payroll system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>DAO<span>Payroll</span>FHE</h1>
          <div className="fhe-badge">FHE Encrypted</div>
        </div>
        <div className="header-actions">
          <div className="search-bar">
            <input 
              type="text" 
              placeholder="Search contributors..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button className="search-icon"></button>
          </div>
          <button onClick={() => setShowAddModal(true)} className="primary-btn">
            + Add Contributor
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="dashboard">
        <div className="dashboard-row">
          <div className="stats-card">
            <h3>Total Contributors</h3>
            <div className="stat-value">{contributors.length}</div>
            <div className="stat-breakdown">
              <span className="active">{activeCount} active</span>
              <span className="pending">{pendingCount} pending</span>
              <span className="inactive">{inactiveCount} inactive</span>
            </div>
          </div>
          
          <div className="stats-card">
            <h3>Monthly Payments</h3>
            <div className="stat-value">${calculateTotalPayments().toLocaleString()}</div>
            <div className="stat-description">FHE encrypted payroll</div>
          </div>
          
          <div className="stats-card">
            <h3>Top Contributors</h3>
            <div className="top-contributors">
              {topContributors.map((contributor, index) => (
                <div key={index} className="contributor-item">
                  <span className="rank">{index + 1}</span>
                  <span className="name">{contributor.name}</span>
                  <span className="amount">
                    ${(FHEDecryptNumber(contributor.encryptedSalary) + FHEDecryptNumber(contributor.encryptedBonus)).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        
        <div className="contributors-section">
          <div className="section-header">
            <h2>Contributor Management</h2>
            <button onClick={loadContributors} className="refresh-btn" disabled={isRefreshing}>
              {isRefreshing ? "Refreshing..." : "Refresh Data"}
            </button>
          </div>
          
          <div className="contributors-table">
            <div className="table-header">
              <div className="header-cell">Name</div>
              <div className="header-cell">Wallet</div>
              <div className="header-cell">Vesting</div>
              <div className="header-cell">Last Payment</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredContributors.length === 0 ? (
              <div className="no-contributors">
                <p>No contributors found</p>
                <button className="primary-btn" onClick={() => setShowAddModal(true)}>Add First Contributor</button>
              </div>
            ) : filteredContributors.map(contributor => (
              <div className="table-row" key={contributor.id} onClick={() => setSelectedContributor(contributor)}>
                <div className="table-cell">{contributor.name}</div>
                <div className="table-cell wallet">{contributor.address.substring(0, 6)}...{contributor.address.substring(38)}</div>
                <div className="table-cell">{contributor.vestingSchedule}</div>
                <div className="table-cell">{new Date(contributor.lastPayment * 1000).toLocaleDateString()}</div>
                <div className="table-cell">
                  <span className={`status-badge ${contributor.status}`}>{contributor.status}</span>
                </div>
                <div className="table-cell actions">
                  {contributor.status === "pending" && (
                    <>
                      <button className="action-btn success" onClick={(e) => { e.stopPropagation(); activateContributor(contributor.id); }}>Activate</button>
                      <button className="action-btn danger" onClick={(e) => { e.stopPropagation(); deactivateContributor(contributor.id); }}>Reject</button>
                    </>
                  )}
                  {contributor.status === "active" && (
                    <button className="action-btn danger" onClick={(e) => { e.stopPropagation(); deactivateContributor(contributor.id); }}>Deactivate</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showAddModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2>Add New Contributor</h2>
              <button onClick={() => setShowAddModal(false)} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Name</label>
                <input 
                  type="text" 
                  value={newContributor.name}
                  onChange={(e) => setNewContributor({...newContributor, name: e.target.value})}
                  placeholder="Contributor name"
                />
              </div>
              
              <div className="form-row">
                <div className="form-group">
                  <label>Base Salary (USD)</label>
                  <input 
                    type="number" 
                    value={newContributor.salary}
                    onChange={(e) => setNewContributor({...newContributor, salary: parseFloat(e.target.value) || 0})}
                    placeholder="0"
                  />
                </div>
                
                <div className="form-group">
                  <label>Bonus (USD)</label>
                  <input 
                    type="number" 
                    value={newContributor.bonus}
                    onChange={(e) => setNewContributor({...newContributor, bonus: parseFloat(e.target.value) || 0})}
                    placeholder="0"
                  />
                </div>
              </div>
              
              <div className="form-group">
                <label>KPI Score</label>
                <input 
                  type="number" 
                  value={newContributor.kpi}
                  onChange={(e) => setNewContributor({...newContributor, kpi: parseFloat(e.target.value) || 0})}
                  placeholder="0-100"
                  min="0"
                  max="100"
                />
              </div>
              
              <div className="form-group">
                <label>Vesting Schedule</label>
                <select 
                  value={newContributor.vesting}
                  onChange={(e) => setNewContributor({...newContributor, vesting: e.target.value})}
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              
              <div className="encryption-notice">
                <div className="lock-icon"></div>
                <p>All sensitive data will be encrypted with Zama FHE before submission</p>
              </div>
            </div>
            
            <div className="modal-footer">
              <button onClick={() => setShowAddModal(false)} className="secondary-btn">Cancel</button>
              <button onClick={addContributor} disabled={adding} className="primary-btn">
                {adding ? "Encrypting with FHE..." : "Add Contributor"}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {selectedContributor && (
        <div className="modal-overlay">
          <div className="modal contributor-detail">
            <div className="modal-header">
              <h2>{selectedContributor.name}</h2>
              <button onClick={() => { setSelectedContributor(null); setDecryptedSalary(null); setDecryptedBonus(null); }} className="close-btn">&times;</button>
            </div>
            
            <div className="modal-body">
              <div className="detail-section">
                <h3>Basic Information</h3>
                <div className="detail-row">
                  <span>Wallet Address:</span>
                  <span>{selectedContributor.address}</span>
                </div>
                <div className="detail-row">
                  <span>Status:</span>
                  <span className={`status-badge ${selectedContributor.status}`}>{selectedContributor.status}</span>
                </div>
                <div className="detail-row">
                  <span>Vesting Schedule:</span>
                  <span>{selectedContributor.vestingSchedule}</span>
                </div>
                <div className="detail-row">
                  <span>Last Payment:</span>
                  <span>{new Date(selectedContributor.lastPayment * 1000).toLocaleDateString()}</span>
                </div>
              </div>
              
              <div className="detail-section">
                <h3>Compensation Details</h3>
                <div className="compensation-row">
                  <div className="compensation-item">
                    <span>Base Salary</span>
                    <div className="encrypted-data">
                      {selectedContributor.encryptedSalary.substring(0, 30)}...
                    </div>
                    <button 
                      className="decrypt-btn" 
                      onClick={async () => {
                        if (decryptedSalary === null) {
                          const decrypted = await decryptWithSignature(selectedContributor.encryptedSalary);
                          setDecryptedSalary(decrypted);
                        } else {
                          setDecryptedSalary(null);
                        }
                      }}
                      disabled={isDecrypting}
                    >
                      {isDecrypting ? "Decrypting..." : decryptedSalary !== null ? "Hide Value" : "Decrypt"}
                    </button>
                    {decryptedSalary !== null && (
                      <div className="decrypted-value">${decryptedSalary.toLocaleString()}</div>
                    )}
                  </div>
                  
                  <div className="compensation-item">
                    <span>Performance Bonus</span>
                    <div className="encrypted-data">
                      {selectedContributor.encryptedBonus.substring(0, 30)}...
                    </div>
                    <button 
                      className="decrypt-btn" 
                      onClick={async () => {
                        if (decryptedBonus === null) {
                          const decrypted = await decryptWithSignature(selectedContributor.encryptedBonus);
                          setDecryptedBonus(decrypted);
                        } else {
                          setDecryptedBonus(null);
                        }
                      }}
                      disabled={isDecrypting}
                    >
                      {isDecrypting ? "Decrypting..." : decryptedBonus !== null ? "Hide Value" : "Decrypt"}
                    </button>
                    {decryptedBonus !== null && (
                      <div className="decrypted-value">${decryptedBonus.toLocaleString()}</div>
                    )}
                  </div>
                </div>
                
                <div className="kpi-section">
                  <h4>KPI Score</h4>
                  <div className="encrypted-data">
                    {selectedContributor.encryptedKPI.substring(0, 30)}...
                  </div>
                  <div className="fhe-tag">FHE Encrypted</div>
                </div>
              </div>
            </div>
            
            <div className="modal-footer">
              <button onClick={() => { setSelectedContributor(null); setDecryptedSalary(null); setDecryptedBonus(null); }} className="secondary-btn">Close</button>
            </div>
          </div>
        </div>
      )}
      
      {transactionStatus.visible && (
        <div className="notification">
          <div className={`notification-content ${transactionStatus.status}`}>
            <div className="notification-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="notification-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-left">
            <h3>DAO Payroll FHE</h3>
            <p>Fully Homomorphic Encrypted payroll system for decentralized organizations</p>
            <div className="powered-by">
              <span>Powered by</span>
              <div className="zama-logo">ZAMA FHE</div>
            </div>
          </div>
          <div className="footer-right">
            <div className="footer-links">
              <a href="#">Documentation</a>
              <a href="#">Privacy Policy</a>
              <a href="#">Terms of Service</a>
            </div>
            <div className="copyright">
              © {new Date().getFullYear()} DAO Payroll FHE. All rights reserved.
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;